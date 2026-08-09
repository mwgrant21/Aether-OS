import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAcpProcess } from './acpProcess';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';
import type { CodexAuthStatus, VerifierStatus } from '../../src/shared/crossEngineTypes';

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

  async initialize(): Promise<void> {
    await this.call('initialize', {});
  }

  /** Only ever sends methodId: 'chat-gpt' -- api-key/gateway methods the
   *  adapter advertises are never selected, even if offered. */
  async authenticate(): Promise<void> {
    await this.call('authenticate', { methodId: 'chat-gpt' });
  }

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

  async probe(): Promise<VerifierStatus> {
    try {
      await this.initialize();
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
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
