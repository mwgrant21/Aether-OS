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
//   account/read                                          -> GetAccountResponse
//   notifications: item/agentMessage/delta { threadId, turnId, itemId, delta }
//                  item/reasoning/textDelta
//                  thread/tokenUsage/updated { tokenUsage: ThreadTokenUsage }
//                  turn/completed { threadId, turn }
//   server->client requests: item/*/requestApproval, execCommandApproval,
//                  applyPatchApproval -- all denied here.
//
// Regenerate and re-diff these bindings whenever the pinned codex version
// moves; the CLI marks this surface [experimental].
//
// TURN OWNERSHIP. A turn's state lives in a TurnRecord owned by this adapter,
// not in a `sendTurn` closure -- see turnRecord.ts for why that distinction
// took seven review rounds to find. `sendTurn` awaits a record's outcome under
// the caller's deadline; the record itself lives as long as the provider-side
// turn can still surprise us, and leaves through exactly one function
// (`retireTurn`).

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
import {
  TurnRecord,
  isTerminalTurnStatus,
  type TurnLike,
  type TurnScopedParams,
  type WaiterResult,
} from './turnRecord';
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

/** Bounds on retained per-turn state. A record whose turn was never
 *  acknowledged has nothing else to remove it. */
const MAX_LIVE_TURNS = 16;
const TURN_RECORD_TTL_MS = 120_000;
const MAX_EARLY_COMPLETIONS = 8;
const MAX_BUFFERED_NOTIFICATIONS = 256;

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
 *  execute without `shell: true` regardless since CVE-2024-27980. */
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
   *  or breaks JSON.parse and gets silently swallowed below. */
  private decoder = new StringDecoder('utf8');
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly threads = new Set<string>();
  /** Per-thread output schema, retained because `turn/start` -- not
   *  `thread/start` -- is what carries it. */
  private readonly outputSchemas = new Map<string, unknown>();
  private serverVersion: string | null = null;

  /** Live turns, keyed by their `turn/start` request id. This one map replaces
   *  what were eleven separate fields (a stream listener, a thread id,
   *  accumulated text and usage, an approval-denial list, a waiter, an
   *  early-completion map, a notification buffer, an active-turn map, an
   *  interrupt set, and a late-handler table), each with its own ad-hoc
   *  lifetime and its own way of going stale. */
  private readonly turns = new Map<number, TurnRecord>();

  constructor(
    private readonly spawnChild: () => ChildProcessWithoutNullStreams = defaultSpawn,
    /** Injectable so the retention bounds can actually be tested rather than
     *  asserted about. */
    private readonly turnRecordTtlMs: number = TURN_RECORD_TTL_MS
  ) {}

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
    // process instead of surfacing a ProviderError.
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

  // --- turn record lifetime ------------------------------------------------

  /** The ONLY way a record leaves `turns`. Every retirement reason -- outcome
   *  reached, deadline with nothing further owed, transport death, dispose,
   *  TTL sweep -- goes through here. */
  private retireTurn(record: TurnRecord): void {
    record.retire();
    this.turns.delete(record.requestId);
  }

  /** Sweeps expired records, then enforces the cap oldest-first.
   *
   *  Neither sweep may touch a record whose caller is still waiting. The TTL
   *  is shorter than the default turn deadline, so expiring on age alone would
   *  retire a legitimately long-running turn out from under its own `sendTurn`
   *  -- whose later deltas and completion would then find no record, turning a
   *  successful turn into a truncated timeout. Only records the caller has
   *  stopped waiting on are eligible.
   *
   *  If every live record is still being awaited, the cap is allowed to be
   *  exceeded. Concurrent callers bound that, and breaking a live turn to
   *  respect a bookkeeping limit is the wrong trade. */
  private boundTurns(): void {
    const now = Date.now();
    for (const record of [...this.turns.values()]) {
      if (!record.callerWaiting && record.expiresAt <= now) this.retireTurn(record);
    }
    while (this.turns.size > MAX_LIVE_TURNS) {
      const evictable = [...this.turns.values()].find((r) => !r.callerWaiting);
      if (!evictable) break;
      this.retireTurn(evictable);
    }
  }

  /** A live record whose accepted id matches, on the right thread. This is how
   *  a notification from a turn that already finished locally is told apart
   *  from one belonging to the turn now running. */
  private recordByTurnId(turnId: string, threadId: string | undefined): TurnRecord | null {
    for (const record of this.turns.values()) {
      if (record.isDone || record.turnId !== turnId) continue;
      if (threadId !== undefined && record.sessionId !== threadId) continue;
      return record;
    }
    return null;
  }

  /** The newest live record for a thread that has not yet learned its id.
   *  Content and completions arriving before `turn/start` answers are parked
   *  here and filtered later by the id we eventually learn -- so parking
   *  something that turns out to belong elsewhere is harmless: it is simply
   *  never claimed. */
  private newestAwaitingAck(threadId: string | undefined): TurnRecord | null {
    if (threadId === undefined) return null;
    let found: TurnRecord | null = null;
    for (const record of this.turns.values()) {
      if (record.isDone || record.turnId !== null) continue;
      if (record.sessionId !== threadId) continue;
      found = record;
    }
    return found;
  }

  /** The newest live record overall, for state whose payload names no thread
   *  (an approval request does not). */
  private newestLiveRecord(): TurnRecord | null {
    let found: TurnRecord | null = null;
    for (const record of this.turns.values()) if (!record.isDone) found = record;
    return found;
  }

  private activeRecordForSession(sessionId: string): TurnRecord | null {
    let found: TurnRecord | null = null;
    for (const record of this.turns.values()) {
      if (record.isDone || record.sessionId !== sessionId) continue;
      found = record;
    }
    return found;
  }

  /** Single teardown path for a child that died for any reason. Clearing
   *  `child` first means every later call fails NOT_CONNECTED rather than
   *  writing to a dead pipe. */
  private onChildGone(reason: string): void {
    if (!this.child) return;
    this.child = null;
    for (const [, p] of this.pending) p.reject(new ProviderError('PROCESS_EXITED', reason));
    this.pending.clear();
    // A dead child can never deliver what these are waiting for. Settling
    // rather than silently dropping is what lets sendTurn throw
    // PROCESS_EXITED instead of reporting a deadline it never reached.
    for (const record of [...this.turns.values()]) {
      record.settle({ kind: 'gone', reason });
      this.retireTurn(record);
    }
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

  // --- transport -----------------------------------------------------------

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
        if (!p) {
          this.onLateResponse(msg.id, msg.error ? null : msg.result);
          continue;
        }
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new ProviderError('PROTOCOL_ERROR', msg.error.message));
        else p.resolve(msg.result);
        continue;
      }
      if (msg.method) this.onNotification(msg.method, msg.params);
    }
  }

  /** A response whose call already timed out. For `turn/start` this is not
   *  junk: its response is the only place the accepted turn id ever appears,
   *  and a cancellation that landed before acknowledgement still needs that id
   *  to interrupt anything. Because the record outlives `sendTurn`, there is
   *  somewhere for it to go. */
  private onLateResponse(id: number, result: unknown): void {
    const record = this.turns.get(id);
    if (!record || record.isDone) return;
    const turn = (result as { turn?: TurnLike } | undefined)?.turn;
    const turnId = typeof turn?.id === 'string' ? turn.id : null;
    if (turnId !== null) {
      record.turnId = turnId;
      if (record.cancelRequested) void this.sendInterrupt(record);
    }
    // sendTurn has already returned; nothing further is owed to the caller.
    this.retireTurn(record);
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
    if (isApproval) this.newestLiveRecord()?.approvalDenials.push({ method, id: String(id) });
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as TurnScopedParams;

    // The real completion signal. turn/start returns as soon as the turn is
    // ACCEPTED, so this is what says how it actually ended.
    if (method === 'turn/completed') {
      const turn = (params as { turn?: TurnLike } | undefined)?.turn ?? null;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      // An unidentifiable completion is ignored rather than guessed at.
      if (!turnId) return;
      const record = this.recordByTurnId(turnId, p.threadId);
      if (record) {
        record.settle({ kind: 'turn', turn });
        return;
      }
      const awaiting = this.newestAwaitingAck(p.threadId);
      if (!awaiting) return;
      if (awaiting.earlyCompletions.size >= MAX_EARLY_COMPLETIONS) {
        awaiting.earlyCompletions.delete(awaiting.earlyCompletions.keys().next().value as string);
      }
      awaiting.earlyCompletions.set(turnId, turn);
      return;
    }

    // Turn-scoped content, matched by turn id: a turn that timed out locally
    // keeps streaming provider-side, and its late deltas must not be appended
    // to the next turn's text.
    const notifTurnId = typeof p.turnId === 'string' ? p.turnId : null;
    if (notifTurnId !== null) {
      const record = this.recordByTurnId(notifTurnId, p.threadId);
      if (record) {
        this.dispatchTurnContent(record, method, p);
        return;
      }
      const awaiting = this.newestAwaitingAck(p.threadId);
      if (awaiting && awaiting.buffered.length < MAX_BUFFERED_NOTIFICATIONS) {
        awaiting.buffered.push({ method, params: p });
      }
      return;
    }

    const record = p.threadId ? this.activeRecordForSession(p.threadId) : null;
    if (record) this.dispatchTurnContent(record, method, p);
  }

  /** Replays what was parked before the accepted id was known, keeping only
   *  what belongs to this turn. */
  private flushBuffered(record: TurnRecord): void {
    const parked = [...record.buffered];
    record.buffered.length = 0;
    if (record.turnId === null) return;
    for (const item of parked) {
      if (item.params.turnId !== record.turnId) continue;
      if (item.params.threadId !== record.sessionId) continue;
      this.dispatchTurnContent(record, item.method, item.params);
    }
  }

  private dispatchTurnContent(record: TurnRecord, method: string, p: TurnScopedParams): void {
    const sessionId = record.sessionId;

    if (method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      record.text += p.delta;
      record.listener({ kind: 'message-chunk', sessionId, text: p.delta });
      return;
    }
    if (
      (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') &&
      typeof p.delta === 'string'
    ) {
      record.listener({ kind: 'reasoning-chunk', sessionId, text: p.delta });
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      record.listener({ kind: 'tool-call', sessionId, name: method, detail: '' });
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      record.usage = readUsage(p.tokenUsage);
      record.listener({ kind: 'usage', sessionId, usage: record.usage });
    }
  }

  private call(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    return this.dispatch(this.nextId++, method, params, timeoutMs);
  }

  /** Sends a request under a pre-allocated id, so a caller that needs the id
   *  before the response exists (sendTurn, to key its record) can have it. */
  private dispatch(id: number, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.require();
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

  // --- provider surface ----------------------------------------------------

  async health(): Promise<ProviderHealth> {
    this.require();
    try {
      // Params are sent as an explicit {} rather than omitted: the server
      // rejects account/read when the params key is absent entirely, and that
      // rejection was being swallowed by the catch below into authMode
      // 'unknown' -- which only the live smoke test caught.
      //
      // GetAccountResponse is `{ account: Account | null, requiresOpenaiAuth }`
      // and Account is a tagged union on `type`
      // ("apiKey" | "chatgpt" | "amazonBedrock") -- NOT a top-level
      // `authMode`. Reading the wrong field made every real ChatGPT login
      // classify as 'unknown', so health() reported ready:false and any
      // health-gated caller was blocked.
      const res = (await this.call('account/read', {})) as
        | { account?: { type?: unknown } | null; requiresOpenaiAuth?: unknown }
        | undefined;
      const type = res?.account?.type;
      // Fails closed: only a proven ChatGPT subscription is `ready`.
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
    // ThreadStartParams does not.
    if (options.outputSchema !== undefined) this.outputSchemas.set(id, options.outputSchema);
    return id;
  }

  async sendTurn(request: TurnRequest, onEvent: (e: ProviderEvent) => void): Promise<TurnResult> {
    this.require();
    if (!this.threads.has(request.sessionId)) {
      throw new ProviderError('UNKNOWN_SESSION', 'no such thread: ' + request.sessionId);
    }

    // ONE deadline for the whole operation. Starting a fresh timer for the
    // second phase let a turn run for nearly twice the caller's limit.
    const timeoutMs = request.timeoutMs ?? 5 * 60_000;
    const deadlineAt = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadlineAt - Date.now());

    const requestId = this.nextId++;
    const record = new TurnRecord(request.sessionId, requestId, onEvent, Date.now() + this.turnRecordTtlMs);
    this.turns.set(requestId, record);
    this.boundTurns();

    const params: Record<string, unknown> = {
      threadId: request.sessionId,
      input: [{ type: 'text', text: request.text, text_elements: [] }],
      ...READ_ONLY_THREAD,
    };
    const schema = this.outputSchemas.get(request.sessionId);
    if (schema !== undefined) params.outputSchema = schema;

    let started: { turn?: TurnLike } | undefined;
    try {
      started = (await this.dispatch(requestId, 'turn/start', params, remaining())) as
        | { turn?: TurnLike }
        | undefined;
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'TIMEOUT') {
        // The record deliberately SURVIVES. The acknowledgement may still
        // arrive, and if a cancellation is outstanding it still has to be
        // carried out -- precisely the state that had no owner before.
        //
        // This is the ONLY path that retains a record, so it is also the only
        // place the caller stops waiting while the record lives on.
        // beginRetention does all three things that must happen together:
        // marks the caller gone, restarts the TTL from NOW (it was set at
        // record creation, which under the shipped defaults is already
        // 180s in the past by this point), and arms the expiry.
        record.beginRetention(this.turnRecordTtlMs, () => this.retireTurn(record));
        return { stopReason: 'timeout', text: record.text, usage: record.usage };
      }
      this.retireTurn(record);
      throw err;
    }

    // Acknowledged: the turn now has a name.
    const acceptedId = typeof started?.turn?.id === 'string' ? started.turn.id : null;
    record.turnId = acceptedId;
    record.phase = 'running';
    this.flushBuffered(record);
    if (acceptedId !== null && record.cancelRequested) void this.sendInterrupt(record);

    if (isTerminalTurnStatus(started?.turn?.status)) {
      return this.finishTurn(record, started?.turn ?? null);
    }

    // The completion may already have arrived while turn/start was in flight.
    if (acceptedId !== null && record.earlyCompletions.has(acceptedId)) {
      return this.finishTurn(record, record.earlyCompletions.get(acceptedId) ?? null);
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<WaiterResult>((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: 'turn', turn: null }), remaining());
    });
    const outcome = await Promise.race([record.outcome, deadline]).finally(() => {
      // Left dangling, a successful turn kept a live timer for the rest of its
      // budget, so turns accumulated timers and a plain Node process could
      // stay alive long after dispose().
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    });

    if (outcome.kind === 'gone') {
      this.retireTurn(record);
      // A transport fault throws, per the contract -- callers must be able to
      // tell a crashed provider from an ordinary deadline.
      throw new ProviderError('PROCESS_EXITED', outcome.reason);
    }
    if (outcome.turn === null && !record.cancelRequested) {
      // Deadline, with the id already known: any interrupt owed has been sent,
      // so nothing further is owed and the record can go.
      this.retireTurn(record);
      return { stopReason: 'timeout', text: record.text, usage: record.usage };
    }
    return this.finishTurn(record, outcome.turn);
  }

  /** Emits the turn's deferred events, maps its outcome, and retires it. */
  private finishTurn(record: TurnRecord, turn: TurnLike | null): TurnResult {
    for (const denial of record.approvalDenials) {
      record.listener({
        kind: 'permission-request',
        sessionId: record.sessionId,
        requestId: denial.id,
        summary: denial.method,
        decision: 'denied',
      });
    }
    const status = turn?.status;
    // An absent or unrecognised status becomes 'error', never 'completed': a
    // turn we cannot prove finished must not reach a synthesis step as if it
    // had.
    const stopReason: TurnStopReason =
      status === 'completed'
        ? 'completed'
        : status === 'interrupted'
          ? 'cancelled'
          : record.cancelRequested
            ? 'cancelled'
            : 'error';
    const result: TurnResult = { stopReason, text: record.text, usage: record.usage };
    this.retireTurn(record);
    return result;
  }

  private async sendInterrupt(record: TurnRecord): Promise<void> {
    if (record.turnId === null || !this.child) return;
    try {
      await this.call('turn/interrupt', { threadId: record.sessionId, turnId: record.turnId }, 10_000);
    } catch {
      // Best effort: the turn may have ended on its own by now.
    }
  }

  /** Records the intent on the turn's own record, and interrupts as soon as an
   *  id exists. A cancel arriving before acknowledgement has no id yet; the
   *  record carries the intent until the acknowledgement supplies one, whether
   *  that lands inside the caller's deadline or long after it. */
  async cancel(sessionId: string): Promise<void> {
    const record = this.activeRecordForSession(sessionId);
    // An idle or finished session is a deliberate no-op, per the contract.
    if (!record) return;
    record.cancelRequested = true;
    if (record.turnId === null || !this.child) return;
    await this.sendInterrupt(record);
  }

  async dispose(): Promise<void> {
    for (const record of [...this.turns.values()]) {
      record.settle({ kind: 'gone', reason: 'adapter disposed' });
      this.retireTurn(record);
    }
    for (const [, p] of this.pending) p.reject(new ProviderError('PROCESS_EXITED', 'adapter disposed'));
    this.pending.clear();
    this.threads.clear();
    this.outputSchemas.clear();
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }

  /** Test-only introspection: how many turn records are retained. Exposed so
   *  the bound is asserted rather than asserted-about. */
  get liveTurnCount(): number {
    return this.turns.size;
  }

  /** @deprecated Prior name, from when this counted a separate late-handler
   *  table. Kept so the existing bound test needs no edit. */
  get retainedLateHandlerCount(): number {
    return this.turns.size;
  }
}
