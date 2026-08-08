import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAcpProcess } from './acpProcess';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';
import type { CodexAuthStatus, VerifierStatus } from '../../src/shared/crossEngineTypes';

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }

/** JSON-RPC over stdio. One line per message, newline-delimited -- the ACP
 *  wire format. Pending requests are tracked by id so responses can arrive
 *  out of order relative to other event traffic on the same stream. */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

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
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // malformed line -- never crash the client on it
      }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
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
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      this.child = null;
    }
  }
}
