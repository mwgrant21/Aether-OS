// ProviderAdapter over `codex app-server` (codex-cli 0.153.2).
//
// Why this exists alongside legacyCodexAcp.ts: the ACP adapter is a one-shot
// verification transport with no resumable sessions, no turn-level
// cancellation, no protocol-level read-only mode, and no structured-output
// contract -- read-only there is achieved by denying every permission request
// after the fact. The app-server protocol supplies all four directly, which is
// what a bounded, multi-round deliberation actually needs.
//
// Every method name, parameter, and response field below was taken from
// bindings generated from the installed CLI itself
// (`codex app-server generate-ts`), not from documentation or memory:
//
//   initialize        { clientInfo, capabilities }        -> InitializeResponse
//   thread/start      ThreadStartParams                   -> { thread: Thread }
//   turn/start        TurnStartParams                     -> { turn: Turn }
//   turn/interrupt    { threadId, turnId }
//   account/read                                          -> account state
//   notifications: item/agentMessage/delta { threadId, turnId, itemId, delta }
//                  item/reasoning/textDelta
//                  thread/tokenUsage/updated { tokenUsage: ThreadTokenUsage }
//   server->client requests: item/*/requestApproval, execCommandApproval,
//                  applyPatchApproval -- all denied here.
//
// Regenerate and re-diff these bindings whenever the pinned codex version
// moves; the CLI marks this surface [experimental].

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  EMPTY_USAGE,
  ProviderError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderHealth,
  type SessionOptions,
  type TurnRequest,
  type TurnResult,
  type TurnStopReason,
  type TurnUsage,
} from './contract';
import { buildCodexChildEnv, resolveCodexHome } from '../acpProcess';

const CLIENT_INFO = { name: 'aether-os', title: 'Aether OS', version: '0.1.0' };

/** Read-only at the protocol level, not by after-the-fact refusal.
 *  `sandbox: 'read-only'` and `approvalPolicy: 'never'` together mean the
 *  agent is never granted a write/exec capability in the first place, so
 *  there is no approval to race. Approval requests are still denied below in
 *  case a future server version asks anyway. */
const READ_ONLY_THREAD = { sandbox: 'read-only' as const, approvalPolicy: 'never' as const };

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'execCommandApproval',
  'applyPatchApproval',
]);

interface JsonRpcLine {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Reads a ThreadTokenUsage's `last` breakdown defensively. Field casing is
 *  not asserted -- both camelCase and snake_case are accepted so a serde
 *  rename in a future codex build degrades to nulls rather than throwing. */
function readUsage(raw: unknown): TurnUsage {
  const last = (raw as { last?: Record<string, unknown> } | undefined)?.last;
  if (!last) return EMPTY_USAGE;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    inputTokens: num(last.inputTokens ?? last.input_tokens),
    outputTokens: num(last.outputTokens ?? last.output_tokens),
    cachedInputTokens: num(last.cachedInputTokens ?? last.cached_input_tokens),
  };
}

/** Spawns the real `codex app-server` against Aether's dedicated CODEX_HOME,
 *  reusing acpProcess.ts's allowlisted child environment so a globally
 *  configured API-key login or unrelated MCP server cannot leak in. */
function defaultSpawn(): ChildProcessWithoutNullStreams {
  const env = buildCodexChildEnv(process.env, resolveCodexHome());
  return spawn('codex', ['app-server'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
}

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly id = 'codex-app-server' as const;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly threads = new Set<string>();
  /** threadId -> turnId of the turn currently in flight. Populated from the
   *  first notification carrying a turnId, because turn/start does not
   *  resolve until the turn is over -- so the id needed to interrupt it can
   *  only come from the stream. */
  private readonly activeTurn = new Map<string, string>();
  private readonly interrupted = new Set<string>();
  private serverVersion: string | null = null;

  /** Denials observed since the current turn started, drained by sendTurn so
   *  they surface as ProviderEvents on the turn that provoked them. */
  private approvalDenials: Array<{ method: string; id: string }> = [];
  private streamListener: ((e: ProviderEvent) => void) | null = null;
  private streamThreadId: string | null = null;
  private streamText = '';
  private streamUsage: TurnUsage = EMPTY_USAGE;

  constructor(private readonly spawnChild: () => ChildProcessWithoutNullStreams = defaultSpawn) {}

  capabilities(): ProviderCapabilities {
    return {
      resumableSessions: true,
      streamingEvents: true,
      permissionRequests: true,
      usageReporting: true,
      cancellation: true,
      structuredOutputSchema: true,
    };
  }

  async connect(): Promise<void> {
    if (this.child) return;
    const child = this.spawnChild();
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    const res = (await this.call('initialize', { clientInfo: CLIENT_INFO, capabilities: null })) as
      | { userAgent?: unknown }
      | undefined;
    this.serverVersion = typeof res?.userAgent === 'string' ? res.userAgent : null;
  }

  private require(): ChildProcessWithoutNullStreams {
    if (!this.child) throw new ProviderError('NOT_CONNECTED', 'codex app-server is not connected');
    return this.child;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcLine;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // never crash the transport on a malformed line
      }
      if (msg.method && msg.id !== undefined) {
        this.answerServerRequest(msg.id, msg.method);
        continue;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new ProviderError('PROTOCOL_ERROR', msg.error.message));
        else p.resolve(msg.result);
        continue;
      }
      if (msg.method) this.onNotification(msg.method, msg.params);
    }
  }

  /** Every server->client request is refused. Approvals are denied; anything
   *  else gets a JSON-RPC "method not found" so the server's request always
   *  completes instead of hanging the turn. */
  private answerServerRequest(id: number | string, method: string): void {
    const child = this.child;
    if (!child) return;
    const isApproval = APPROVAL_METHODS.has(method);
    const body = isApproval
      ? { jsonrpc: '2.0', id, result: { decision: 'denied' } }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not supported: ' + method } };
    child.stdin.write(JSON.stringify(body) + '\n');
    if (isApproval) this.approvalDenials.push({ method, id: String(id) });
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as {
      threadId?: string;
      turnId?: string;
      delta?: string;
      tokenUsage?: unknown;
    };
    if (p.threadId && p.turnId) this.activeTurn.set(p.threadId, p.turnId);
    if (!this.streamListener || !this.streamThreadId || p.threadId !== this.streamThreadId) return;
    const sessionId = this.streamThreadId;

    if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      this.streamText += p.delta;
      this.streamListener({ kind: 'message-chunk', sessionId, text: p.delta });
      return;
    }
    if (
      (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') &&
      typeof p.delta === 'string'
    ) {
      this.streamListener({ kind: 'reasoning-chunk', sessionId, text: p.delta });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.streamListener({ kind: 'tool-call', sessionId, name: method, detail: '' });
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      this.streamUsage = readUsage(p.tokenUsage);
      this.streamListener({ kind: 'usage', sessionId, usage: this.streamUsage });
    }
  }

  private call(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.require();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError('TIMEOUT', 'app-server call "' + method + '" timed out'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async health(): Promise<ProviderHealth> {
    this.require();
    try {
      const account = (await this.call('account/read')) as { authMode?: unknown } | undefined;
      const mode = typeof account?.authMode === 'string' ? account.authMode : 'unknown';
      // Fails closed: only a recognised subscription login is `ready`. An
      // api-key or gateway login is a billing mode this project refuses, and
      // anything unrecognised is treated as unproven rather than assumed fine.
      const authMode =
        mode === 'chatgpt' || mode === 'chat-gpt' || mode === 'subscription'
          ? ('subscription' as const)
          : mode === 'apikey' || mode === 'api-key'
            ? ('api-key' as const)
            : mode === 'gateway'
              ? ('gateway' as const)
              : mode === 'unauthenticated'
                ? ('unauthenticated' as const)
                : ('unknown' as const);
      return {
        ready: authMode === 'subscription',
        authMode,
        version: this.serverVersion,
        detail: 'account/read reported authMode=' + mode,
      };
    } catch (err) {
      return {
        ready: false,
        authMode: 'unknown',
        version: this.serverVersion,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async newSession(options: SessionOptions): Promise<string> {
    this.require();
    const res = (await this.call('thread/start', { cwd: options.cwd, ...READ_ONLY_THREAD })) as
      | { thread?: { id?: unknown } }
      | undefined;
    const id = res?.thread?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new ProviderError('PROTOCOL_ERROR', 'thread/start returned no thread id');
    }
    this.threads.add(id);
    return id;
  }

  async sendTurn(request: TurnRequest, onEvent: (e: ProviderEvent) => void): Promise<TurnResult> {
    this.require();
    if (!this.threads.has(request.sessionId)) {
      throw new ProviderError('UNKNOWN_SESSION', 'no such thread: ' + request.sessionId);
    }

    this.streamListener = onEvent;
    this.streamThreadId = request.sessionId;
    this.streamText = '';
    this.streamUsage = EMPTY_USAGE;
    this.approvalDenials = [];

    try {
      const params: Record<string, unknown> = {
        threadId: request.sessionId,
        input: [{ type: 'text', text: request.text, text_elements: [] }],
        ...READ_ONLY_THREAD,
      };
      const res = (await this.call('turn/start', params, request.timeoutMs ?? 5 * 60_000)) as
        | { turn?: { status?: unknown } }
        | undefined;

      for (const denial of this.approvalDenials) {
        onEvent({
          kind: 'permission-request',
          sessionId: request.sessionId,
          requestId: denial.id,
          summary: denial.method,
          decision: 'denied',
        });
      }

      const status = res?.turn?.status;
      // TurnStatus is "completed" | "interrupted" | "failed" | "inProgress".
      // An absent or unrecognised status becomes 'error', never 'completed':
      // a turn we cannot prove finished must not reach a synthesis step as if
      // it had.
      const stopReason: TurnStopReason =
        status === 'completed'
          ? 'completed'
          : status === 'interrupted'
            ? 'cancelled'
            : this.interrupted.has(request.sessionId)
              ? 'cancelled'
              : 'error';

      return { stopReason, text: this.streamText, usage: this.streamUsage };
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'TIMEOUT') {
        return { stopReason: 'timeout', text: this.streamText, usage: this.streamUsage };
      }
      throw err;
    } finally {
      this.interrupted.delete(request.sessionId);
      this.activeTurn.delete(request.sessionId);
      this.streamListener = null;
      this.streamThreadId = null;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const turnId = this.activeTurn.get(sessionId);
    this.interrupted.add(sessionId);
    // No active turn (or not connected) is a deliberate no-op, per the
    // contract -- a cancel racing a completing turn is not an error.
    if (!turnId || !this.child) return;
    try {
      await this.call('turn/interrupt', { threadId: sessionId, turnId }, 10_000);
    } catch {
      // Best effort: the turn may have finished between the lookup and the
      // call. sendTurn's stop-reason logic already covers that race.
    }
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) p.reject(new ProviderError('PROCESS_EXITED', 'adapter disposed'));
    this.pending.clear();
    this.threads.clear();
    this.activeTurn.clear();
    this.interrupted.clear();
    this.streamListener = null;
    this.streamThreadId = null;
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
