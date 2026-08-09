import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAcpProcess } from './acpProcess';
import { CHAT_GPT_AUTH_METHOD_ID, isAllowedAuthStatus, offersChatGptAuthMethod } from './codexSubscriptionPolicy';
import type { CodexAuthStatus, VerifierStatus } from '../../src/shared/crossEngineTypes';

/** The ACP protocol version this client speaks. `InitializeRequest.protocolVersion`
 *  is a REQUIRED number with no default -- see @agentclientprotocol/sdk's
 *  dist/schema/types.gen.d.ts:4098-4102 and its zod parser
 *  dist/schema/zod.gen.js:2292 (`protocolVersion: zProtocolVersion`, not
 *  `.optional()`/`.default()`). The value 1 is the SDK's own exported
 *  `PROTOCOL_VERSION` constant (dist/schema/index.d.ts:51, re-exported from
 *  dist/acp.d.ts:5); it is duplicated here as a literal rather than imported
 *  so the Electron main bundle doesn't pull the SDK's ESM entry and its `zod`
 *  peer dependency in for a single integer.
 *
 *  Not a guess: a live handshake against the real
 *  Codex ACP adapter (v1.1.14) confirmed that
 *  `initialize {}` is answered with
 *  `-32602 Invalid params ... protocolVersion: expected number, received undefined`
 *  and the adapter then exits, while `initialize { protocolVersion: 1 }`
 *  returns a full InitializeResponse. That rejection is the root cause of the
 *  adapter window flashing open and closing again with no connection. */
const PROTOCOL_VERSION = 1;

/** `authenticate` is also the real login path: if the operator is not already
 *  signed in, the adapter opens a browser for the OAuth flow and the call does
 *  not resolve until a human finishes it (`authenticateWithChatGpt()`,
 *  adapter dist/index.js:26337-26349). The default 15s call timeout is far
 *  too short for that, so this one call gets the same 5-minute budget as
 *  codexVerifier.ts's RUN_TIMEOUT_MS. */
const AUTH_TIMEOUT_MS = 5 * 60_000;

/** Minimal shape of the entries in `InitializeResponse.authMethods`
 *  (`AuthMethod`, types.gen.d.ts). Only `id` is ever read, so the full SDK
 *  type surface is deliberately not imported. */
export interface AcpAuthMethod { id: string }

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
/** A raw incoming line can be a response to one of our requests (has `id`,
 *  no `method`), an incoming request FROM the agent that we must answer
 *  (has both `id` and `method` -- e.g. `session/request_permission`), or a
 *  notification (has `method`, no `id` -- e.g. `session/update`). All three
 *  share one wire shape; the fields present distinguish them. */
interface JsonRpcLine { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }

/** Minimal shape of a `session/update` notification's `agent_message_chunk`
 *  variant -- see @agentclientprotocol/sdk's schema/types.gen.d.ts
 *  (SessionNotification, SessionUpdate, ContentChunk, ContentBlock). Only
 *  the text-content case is read; other content/update kinds are ignored. */
interface SessionUpdateParams {
  sessionId?: string;
  update?: { sessionUpdate?: string; content?: { type?: string; text?: string } };
}

/** JSON-RPC over stdio. One line per message, newline-delimited -- the ACP
 *  wire format. Pending requests are tracked by id so responses can arrive
 *  out of order relative to other event traffic on the same stream. */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  /** Accumulates `agent_message_chunk` text per sessionId as `session/update`
   *  notifications stream in, so `prompt()` can read back the final message
   *  once the `session/prompt` response (stop reason) arrives. */
  private agentMessageBuffers = new Map<string, string>();
  /** Auth methods from this connection's one successful `initialize`. Doubles
   *  as the "handshake already done" flag -- see `initialize()`. */
  private authMethods: AcpAuthMethod[] | null = null;

  connect(child: ChildProcessWithoutNullStreams = spawnAcpProcess()): void {
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
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
        continue; // malformed line -- never crash the client on it
      }
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        this.handleIncomingRequest(msg.id, msg.method);
        continue;
      }
      if (typeof msg.id === 'number') {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
        continue;
      }
      if (typeof msg.method === 'string') {
        this.handleNotification(msg.method, msg.params);
      }
    }
  }

  /** Responds to requests the agent sends us. The only one this client
   *  supports is `session/request_permission`, which it always denies
   *  (`outcome: 'cancelled'`) -- verification runs are read-only by policy,
   *  so any write/exec permission the agent asks for is refused rather than
   *  granted. Any other incoming method gets a JSON-RPC "method not found"
   *  error so the agent's request always completes instead of hanging. */
  private handleIncomingRequest(id: number, method: string): void {
    if (!this.child) return;
    if (method === 'session/request_permission') {
      const res = { jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } };
      this.child.stdin.write(JSON.stringify(res) + '\n');
      return;
    }
    const res = { jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } };
    this.child.stdin.write(JSON.stringify(res) + '\n');
  }

  /** Handles `session/update` notifications, the only notification this
   *  client reads. Only the `agent_message_chunk` variant's text content is
   *  appended -- tool-call, plan, and thought updates are ignored, matching
   *  `prompt()`'s contract of returning just the agent's final message. */
  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const p = params as SessionUpdateParams | undefined;
    if (!p?.sessionId || !p.update) return;
    if (p.update.sessionUpdate === 'agent_message_chunk' && p.update.content?.type === 'text' && typeof p.update.content.text === 'string') {
      const existing = this.agentMessageBuffers.get(p.sessionId) ?? '';
      this.agentMessageBuffers.set(p.sessionId, existing + p.update.content.text);
    }
  }

  private call(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP call "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  /** Performs the ACP handshake and returns the auth methods the agent
   *  advertises (`InitializeResponse.authMethods`, types.gen.d.ts:1435).
   *  Callers use that list to confirm ChatGPT subscription auth is actually
   *  on offer before any `authenticate` request is built. A response with no
   *  `authMethods` at all yields an empty array, which fails closed through
   *  `offersChatGptAuthMethod`.
   *
   *  Idempotent per connection, and it has to be: `initialize` is a one-shot
   *  handshake, and the real adapter answers a SECOND one on the same stdio
   *  connection with `-32603 Internal error {"details":"Already initialized"}`
   *  (verified live) while leaving the connection otherwise usable. Callers
   *  that legitimately compose -- e.g. main.ts running
   *  `ensureChatGptAuthenticated()` and then `probe()` on one client -- would
   *  otherwise turn that second handshake into a spurious 'error' status. */
  async initialize(): Promise<AcpAuthMethod[]> {
    if (this.authMethods) return this.authMethods;
    const result = (await this.call('initialize', { protocolVersion: PROTOCOL_VERSION })) as { authMethods?: unknown } | undefined;
    const methods = result?.authMethods;
    // Cached only on success -- a failed handshake leaves this null so the
    // next call genuinely retries rather than reporting a phantom empty list.
    this.authMethods = Array.isArray(methods) ? (methods as AcpAuthMethod[]) : [];
    return this.authMethods;
  }

  /** Only ever sends methodId: 'chat-gpt' -- the api-key/gateway methods the
   *  adapter advertises are never selected, even though the real adapter
   *  offers `api-key` unconditionally. The request object is built from the
   *  `CHAT_GPT_AUTH_METHOD_ID` literal, never from a variable derived from
   *  the advertised list, so there is structurally no code path that can send
   *  any other methodId.
   *
   *  This is the ONLY call in this client that can open a browser window, so
   *  it must never be reached from a passive status path -- see `probe()`. */
  async authenticate(): Promise<void> {
    await this.call('authenticate', { methodId: CHAT_GPT_AUTH_METHOD_ID }, AUTH_TIMEOUT_MS);
  }

  /** Passive, read-only query of the live account state -- it never opens a
   *  browser and never mutates login state.
   *
   *  `authentication/status` is absent from the ACP spec's `AGENT_METHODS`
   *  because it is a Codex-specific ACP *extension* method; the real adapter
   *  registers it under exactly that JSON-RPC method name
   *  (adapter dist/index.js:31697 `.onRequest("authentication/status", ...)`)
   *  and answers it from `getAuthenticationStatus()` (index.js:26399), which
   *  only reads config and calls `accountRead({ refreshToken: false })`
   *  (index.js:26528). Verified live against the real adapter: it responds
   *  `{"type":"unauthenticated"}` on a fresh CODEX_HOME with no login. */
  async authenticationStatus(): Promise<CodexAuthStatus> {
    try {
      const result = (await this.call('authentication/status')) as { type?: string };
      const type = result?.type;
      if (type === 'chat-gpt' || type === 'api-key' || type === 'gateway' || type === 'unauthenticated') return type;
      return 'unknown';
    } catch {
      return 'unknown'; // any failure to prove status is treated as unknown -- fails closed downstream
    }
  }

  /** The full, real check behind the operator's explicit CONNECT CHATGPT
   *  action, and the only method here that may trigger a login/browser popup.
   *  It must never be called from a passive status path.
   *
   *  Order matters and is fail-closed at every step:
   *   1. `initialize` -- if `chat-gpt` is not among the advertised methods,
   *      return false WITHOUT sending `authenticate` at all. There is no
   *      fallback to `api-key` or `gateway`.
   *   2. If `authentication/status` already reports `chat-gpt`, we are done --
   *      no `authenticate` call, so no needless browser window.
   *   3. Otherwise send `authenticate` (long timeout, a human may be
   *      completing an OAuth flow) and then re-read the real status rather
   *      than trusting the call's empty `AuthenticateResponse` as proof.
   *  Any rejection or timeout resolves to false. */
  async ensureChatGptAuthenticated(): Promise<boolean> {
    try {
      const authMethods = await this.initialize();
      if (!offersChatGptAuthMethod(authMethods)) return false;
      if (isAllowedAuthStatus(await this.authenticationStatus())) return true;
      await this.authenticate();
      return isAllowedAuthStatus(await this.authenticationStatus());
    } catch {
      return false;
    }
  }

  /** Thin wrapper over `session/new` (see @agentclientprotocol/sdk's
   *  NewSessionRequest/NewSessionResponse). `mcpServers` is always sent as
   *  an empty array here -- verification runs never connect MCP servers
   *  (no MCP, and no web-search tool arrives without one), so "no MCP" and
   *  "no web search" are enforced by never populating this field, not by a
   *  request-level flag (the real protocol has none). */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.call('session/new', { cwd, mcpServers: [] })) as { sessionId: string };
    return result.sessionId;
  }

  /** Thin wrapper over `session/prompt` (see @agentclientprotocol/sdk's
   *  PromptRequest/PromptResponse) that also creates the session it prompts
   *  into via `session/new`. Returns the parsed JSON payload from the final
   *  `agent_message_chunk` text accumulated over the turn's `session/update`
   *  notifications -- not the `PromptResponse` itself, which carries only a
   *  `stopReason` and optional token usage, not the agent's answer. If the
   *  accumulated text isn't valid JSON, the raw string is returned instead
   *  of throwing; `parseVerificationResult` treats any non-object input as
   *  inconclusive rather than a parse error blowing up the run.
   *  "Read-only" is enforced separately, by `handleIncomingRequest` denying
   *  every `session/request_permission` the agent sends during the turn. */
  async prompt(params: { cwd: string; text: string }): Promise<unknown> {
    const sessionId = await this.newSession(params.cwd);
    this.agentMessageBuffers.set(sessionId, '');
    try {
      await this.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: params.text }] }, 5 * 60_000);
      const text = this.agentMessageBuffers.get(sessionId) ?? '';
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } finally {
      this.agentMessageBuffers.delete(sessionId);
    }
  }

  /** Passive status check. Sends only `initialize` and `authentication/status`
   *  -- never `authenticate` -- so mounting a settings card or the Uplinks
   *  view can never pop a browser window as a side effect of merely being
   *  looked at. Both calls are read-only against the adapter.
   *
   *  Unlike a cached "we authenticated earlier this process" flag, this
   *  reports the adapter's live account state, so it stays correct if the
   *  operator logs out elsewhere. Anything that isn't provably `chat-gpt`
   *  fails closed to a non-ready status. */
  async probe(): Promise<VerifierStatus> {
    try {
      const authMethods = await this.initialize();
      if (!offersChatGptAuthMethod(authMethods)) return 'blocked-billing-mode';
      const status = await this.authenticationStatus();
      if (status === 'unauthenticated') return 'sign-in-required';
      if (isAllowedAuthStatus(status)) return 'ready-subscription';
      return 'blocked-billing-mode';
    } catch {
      return 'error';
    }
  }

  async dispose(): Promise<void> {
    for (const [, p] of this.pending) p.reject(new Error('client disposed'));
    this.pending.clear();
    this.agentMessageBuffers.clear();
    this.authMethods = null; // a future connect() gets a fresh handshake
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
