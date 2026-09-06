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
import { StringDecoder } from 'node:string_decoder';
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
import { attachStderrRingBuffer, buildCodexChildEnv, resolveCodexCliEntry, resolveCodexHome } from '../acpProcess';

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

/** The fields every turn-scoped notification carries. `turnId` is what makes
 *  a late notification from a previous turn distinguishable from this turn's. */
interface TurnScopedParams {
  threadId?: string;
  turnId?: string;
  delta?: string;
  tokenUsage?: unknown;
}

/** Minimal shape of the generated `Turn` this adapter reads. `id` matters:
 *  a completion notification must be matched to the turn it belongs to, not
 *  merely to the thread. */
type TurnLike = { id?: unknown; status?: unknown; error?: unknown };

/** How a turn stopped waiting. A dead transport is NOT a deadline, and the
 *  contract requires transport faults to throw rather than return a stop
 *  reason -- collapsing both into "no turn arrived" hid a crashed provider
 *  behind stopReason: 'timeout'. */
type WaiterResult = { kind: 'turn'; turn: TurnLike | null } | { kind: 'gone'; reason: string };

/** Completions that arrive before turn/start's response has told us the turn
 *  id are stashed here, keyed by id. Bounded: cleared at the start and end of
 *  every turn, and capped regardless. */
const MAX_EARLY_COMPLETIONS = 8;

/** Turn-scoped content notifications can arrive before turn/start's response
 *  has told us which turn was accepted, so they are buffered rather than
 *  dropped. Bounded: cleared at the start and end of every turn. */
const MAX_BUFFERED_NOTIFICATIONS = 256;

/** TurnStatus is "completed" | "interrupted" | "failed" | "inProgress".
 *  Only the first three are outcomes; "inProgress" means the answer has not
 *  arrived yet. */
function isTerminalTurnStatus(status: unknown): boolean {
  return status === 'completed' || status === 'interrupted' || status === 'failed';
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
 *  configured API-key login or unrelated MCP server cannot leak in.
 *
 *  Launches the resolved `bin/codex.js` with the current Node executable
 *  rather than `spawn('codex')`. The bare name cannot work on Windows: the
 *  npm-installed `codex` is a `.cmd` shim, which Node's non-shell spawn does
 *  not resolve (verified on this machine: ENOENT, exit -4058) and refuses to
 *  execute without `shell: true` regardless since CVE-2024-27980. Every unit
 *  test injects a fake child, so nothing exercised this path until it was
 *  reviewed -- the adapter was dead on the one platform this app targets. */
function defaultSpawn(): ChildProcessWithoutNullStreams {
  const env = buildCodexChildEnv(process.env, resolveCodexHome());
  const child = spawn(process.execPath, [resolveCodexCliEntry(), 'app-server'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  attachStderrRingBuffer(child);
  return child;
}

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly id = 'codexAppServer' as const;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  /** A raw `chunk.toString('utf8')` mangles any multi-byte character split
   *  across a read boundary into U+FFFD, which then either corrupts the text
   *  or breaks JSON.parse and gets silently swallowed below. StringDecoder
   *  holds the partial sequence until the rest arrives. */
  private decoder = new StringDecoder('utf8');
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly threads = new Set<string>();
  /** threadId -> turnId of the turn currently in flight, and the id cancel()
   *  interrupts. Populated ONLY from turn/start's accepted turn -- never from
   *  a notification, which can belong to a previous turn still finishing.
   *  (The original comment here claimed the id could only come from the
   *  stream, because turn/start was believed not to resolve until the turn was
   *  over. That was backwards: turn/start resolves on acceptance and carries
   *  the id.) */
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
  /** Settled by the `turn/completed` notification (or by child death). See
   *  sendTurn's TURN LIFECYCLE note. */
  private turnWaiter: { sessionId: string; turnId: string | null; settle: (result: WaiterResult) => void } | null = null;
  private readonly earlyCompletions = new Map<string, TurnLike | null>();
  private bufferedTurnNotifications: Array<{ method: string; params: TurnScopedParams }> = [];
  /** Per-thread output schema, retained because `turn/start` -- not
   *  `thread/start` -- is what carries it. */
  private readonly outputSchemas = new Map<string, unknown>();

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
    // Without these, an ENOENT (or any spawn failure, crash, or EPIPE from a
    // write after death) emits 'error' on an emitter with no listener, which
    // Node throws as an uncaught exception -- crashing the Electron main
    // process instead of surfacing a ProviderError. They also unblock every
    // pending call immediately rather than letting each hang to its own
    // timeout, which for turn/start is five minutes.
    child.on('error', (err: Error) => this.onChildGone('codex app-server failed: ' + err.message));
    child.on('close', (code: number | null) => this.onChildGone('codex app-server exited (code ' + code + ')'));
    const res = (await this.call('initialize', { clientInfo: CLIENT_INFO, capabilities: null })) as
      | { userAgent?: unknown }
      | undefined;
    this.serverVersion = typeof res?.userAgent === 'string' ? res.userAgent : null;
  }

  private require(): ChildProcessWithoutNullStreams {
    if (!this.child) throw new ProviderError('NOT_CONNECTED', 'codex app-server is not connected');
    return this.child;
  }

  /** Single teardown path for a child that died for any reason. Clearing
   *  `child` first means every later call fails NOT_CONNECTED rather than
   *  writing to a dead pipe. */
  private onChildGone(reason: string): void {
    if (!this.child) return;
    this.child = null;
    for (const [, p] of this.pending) p.reject(new ProviderError('PROCESS_EXITED', reason));
    this.pending.clear();
    // A turn awaiting turn/completed must not hang for the full deadline when
    // the server it was waiting on is gone -- and must not report that as a
    // timeout either, which would hide a crashed provider from the caller.
    this.turnWaiter?.settle({ kind: 'gone', reason });
  }

  /** stdin writes throw EPIPE once the child is gone; that must surface as a
   *  ProviderError on the call, never as an unhandled throw. */
  private writeLine(child: ChildProcessWithoutNullStreams, body: unknown): void {
    try {
      child.stdin.write(JSON.stringify(body) + '\n');
    } catch (err) {
      this.onChildGone('write to codex app-server failed: ' + (err instanceof Error ? err.message : String(err)));
      throw new ProviderError('PROCESS_EXITED', 'codex app-server is no longer writable');
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
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
    try {
      this.writeLine(child, body);
    } catch {
      return; // the child is gone; the turn's pending call already rejected
    }
    if (isApproval) this.approvalDenials.push({ method, id: String(id) });
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as TurnScopedParams;
    // activeTurn is NOT set from notifications. It used to be, unconditionally
    // and before the accepted-id gate below, which meant a late notification
    // from a previous turn could overwrite it with that turn's id -- and
    // cancel(), which reads activeTurn, would then interrupt the OLD turn
    // while the accepted one kept running. The id is now retained from
    // turn/start's accepted turn only (see sendTurn), which is the single
    // authoritative source and cannot be poisoned by a stale notification.
    if (!this.streamListener || !this.streamThreadId || p.threadId !== this.streamThreadId) return;
    const sessionId = this.streamThreadId;

    // The real completion signal. turn/start returns as soon as the turn is
    // ACCEPTED, so this is what says how it actually ended.
    if (method === 'turn/completed') {
      const turn = (params as { turn?: TurnLike } | undefined)?.turn ?? null;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      // Matched by TURN id, not just thread id. A turn that timed out locally
      // can still complete provider-side, and that late notification would
      // otherwise settle the NEXT turn on the same thread with the previous
      // turn's status and text. An unidentifiable completion is ignored (the
      // waiting turn then hits its deadline) rather than guessed at.
      if (!turnId) return;
      if (this.turnWaiter && this.turnWaiter.turnId === turnId) {
        this.turnWaiter.settle({ kind: 'turn', turn });
        return;
      }
      // Arrived before turn/start's response told us the id -- normal, since
      // the server may answer the notification first.
      if (this.earlyCompletions.size >= MAX_EARLY_COMPLETIONS) {
        this.earlyCompletions.delete(this.earlyCompletions.keys().next().value as string);
      }
      this.earlyCompletions.set(turnId, turn);
      return;
    }

    // Everything below is turn-scoped CONTENT. Matching only turn/completed on
    // turn id was not enough: a turn that timed out locally keeps streaming
    // provider-side, and its late deltas and usage would otherwise be appended
    // to the NEXT turn's text -- so a correctly-matched second completion
    // could still carry the first turn's content.
    const accepted = this.turnWaiter?.turnId ?? null;
    const notifTurnId = typeof p.turnId === 'string' ? p.turnId : null;
    if (notifTurnId !== null) {
      if (accepted === null) {
        // turn/start has not told us the accepted id yet. Buffer rather than
        // drop: these are very likely this turn's own opening deltas.
        if (this.bufferedTurnNotifications.length < MAX_BUFFERED_NOTIFICATIONS) {
          this.bufferedTurnNotifications.push({ method, params: p });
        }
        return;
      }
      if (notifTurnId !== accepted) return; // a previous turn still finishing
    }
    this.dispatchTurnContent(method, p);
  }

  /** Replays notifications buffered before the accepted turn id was known,
   *  keeping only those that belong to it. */
  private flushBufferedTurnNotifications(acceptedId: string | null): void {
    const buffered = this.bufferedTurnNotifications;
    this.bufferedTurnNotifications = [];
    if (acceptedId === null) return;
    for (const item of buffered) {
      if (item.params.turnId !== acceptedId) continue;
      if (item.params.threadId !== this.streamThreadId) continue;
      this.dispatchTurnContent(item.method, item.params);
    }
  }

  private dispatchTurnContent(method: string, p: TurnScopedParams): void {
    if (!this.streamListener || !this.streamThreadId) return;
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
      try {
        this.writeLine(child, { jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  async health(): Promise<ProviderHealth> {
    this.require();
    try {
      // Params are sent as an explicit {} rather than omitted: the server
      // rejects account/read when the params key is absent entirely, and the
      // rejection was being swallowed by the catch below into authMode
      // 'unknown' -- which the live smoke test caught.
      // GetAccountResponse is `{ account: Account | null, requiresOpenaiAuth }`
      // and Account is a tagged union on `type`
      // ("apiKey" | "chatgpt" | "amazonBedrock") -- NOT a top-level
      // `authMode`. Reading the wrong field made every real ChatGPT login
      // classify as 'unknown', so health() reported ready:false and any
      // health-gated caller was blocked. Field names taken from the generated
      // bindings, not guessed.
      const res = (await this.call('account/read', {})) as
        | { account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown }
        | undefined;
      const type = res?.account?.type;
      // Fails closed: only a proven ChatGPT subscription is `ready`. An
      // api-key or Bedrock login is a billing mode this project refuses, and
      // anything unrecognised is unproven rather than assumed fine.
      const authMode =
        type === 'chatgpt'
          ? ('subscription' as const)
          : type === 'apiKey'
            ? ('api-key' as const)
            : type === 'amazonBedrock'
              ? ('gateway' as const)
              : res && res.account === null
                ? ('unauthenticated' as const)
                : ('unknown' as const);
      return {
        ready: authMode === 'subscription',
        authMode,
        version: this.serverVersion,
        detail: 'account/read reported account.type=' + (typeof type === 'string' ? type : '(absent)'),
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
    // Retained rather than sent here: TurnStartParams carries outputSchema,
    // ThreadStartParams does not. Dropping it while capabilities() advertises
    // structuredOutputSchema:true would let a caller trust a constraint that
    // was never applied.
    if (options.outputSchema !== undefined) this.outputSchemas.set(id, options.outputSchema);
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
      const timeoutMs = request.timeoutMs ?? 5 * 60_000;
      const params: Record<string, unknown> = {
        threadId: request.sessionId,
        input: [{ type: 'text', text: request.text, text_elements: [] }],
        ...READ_ONLY_THREAD,
      };
      const schema = this.outputSchemas.get(request.sessionId);
      if (schema !== undefined) params.outputSchema = schema;

      // TURN LIFECYCLE. turn/start resolves as soon as the turn is ACCEPTED,
      // typically with status "inProgress"; the assistant deltas and the real
      // outcome arrive afterwards as notifications, ending in turn/completed.
      // Treating the turn/start response as the outcome classified every
      // normal turn as 'error' and returned empty text, while also clearing
      // the stream listener before any content arrived.
      //
      // Both shapes are handled rather than betting on one: a response that
      // is ALREADY terminal is used as-is, otherwise the turn stays pending
      // until turn/completed (or the deadline, or child death).
      // ONE deadline for the whole operation. Starting a fresh timeoutMs
      // timer after turn/start had already consumed part of it let a turn run
      // for nearly twice the caller's limit.
      const deadlineAt = Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadlineAt - Date.now());

      let settleWaiter: (result: WaiterResult) => void = () => {};
      const completed = new Promise<WaiterResult>((resolve) => {
        let done = false;
        settleWaiter = (result) => {
          if (done) return;
          done = true;
          resolve(result);
        };
      });
      this.turnWaiter = { sessionId: request.sessionId, turnId: null, settle: settleWaiter };
      this.earlyCompletions.clear();
      this.bufferedTurnNotifications = [];

      const started = (await this.call('turn/start', params, remaining())) as { turn?: TurnLike } | undefined;
      const acceptedId = typeof started?.turn?.id === 'string' ? started.turn.id : null;
      if (this.turnWaiter) this.turnWaiter.turnId = acceptedId;
      // Also record it as the active turn. cancel() reads activeTurn, which
      // otherwise only gets populated by a notification carrying turnId -- so
      // if turn/start answered first, a cancel during the wait for
      // turn/completed would find no id and silently fail to interrupt.
      if (acceptedId !== null) this.activeTurn.set(request.sessionId, acceptedId);
      this.flushBufferedTurnNotifications(acceptedId);

      let res: { turn?: TurnLike } | undefined = started;
      if (!isTerminalTurnStatus(started?.turn?.status)) {
        // The completion may already have arrived while turn/start was still
        // in flight.
        const early = acceptedId !== null && this.earlyCompletions.has(acceptedId);
        if (early) {
          res = { turn: this.earlyCompletions.get(acceptedId as string) ?? undefined };
        } else {
          // The timer handle is retained and cleared once the race settles.
          // Left dangling, a successful turn kept a live timer for the rest of
          // its budget -- nearly five minutes by default -- so turns
          // accumulated timers and a plain Node process using this adapter
          // could stay alive long after dispose().
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<WaiterResult>((resolve) => {
            deadlineTimer = setTimeout(() => resolve({ kind: 'turn', turn: null }), remaining());
          });
          const outcome = await Promise.race([completed, deadline]).finally(() => {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          });
          if (outcome.kind === 'gone') {
            // A transport fault throws, per the contract -- callers must be
            // able to tell a crashed provider from an ordinary deadline.
            throw new ProviderError('PROCESS_EXITED', outcome.reason);
          }
          if (outcome.turn === null && !this.interrupted.has(request.sessionId)) {
            return { stopReason: 'timeout', text: this.streamText, usage: this.streamUsage };
          }
          res = { turn: outcome.turn ?? undefined };
        }
      }

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
      this.turnWaiter = null;
      this.earlyCompletions.clear();
      this.bufferedTurnNotifications = [];
      this.interrupted.delete(request.sessionId);
      this.activeTurn.delete(request.sessionId);
      this.streamListener = null;
      this.streamThreadId = null;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const turnId = this.activeTurn.get(sessionId);
    // Only record the interrupt when a turn is actually in flight. Marking an
    // idle session leaves the flag set with no sendTurn to clear it, and the
    // NEXT turn then maps a genuine provider-side `failed` status to
    // 'cancelled' -- reporting a real failure as an operator abort.
    if (!this.streamThreadId || this.streamThreadId !== sessionId) return;
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
    // An in-flight turn must fail rather than hang to its deadline.
    this.turnWaiter?.settle({ kind: 'gone', reason: 'adapter disposed' });
    this.earlyCompletions.clear();
    this.bufferedTurnNotifications = [];
    for (const [, p] of this.pending) p.reject(new ProviderError('PROCESS_EXITED', 'adapter disposed'));
    this.pending.clear();
    this.threads.clear();
    this.outputSchemas.clear();
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
