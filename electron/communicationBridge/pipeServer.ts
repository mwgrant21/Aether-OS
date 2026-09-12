import { createServer, createConnection, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExchangeClient, ExchangeResponse } from './exchangeController';

export const PIPE_FRAME_BYTES = 384 * 1024;
const MAX_REQUESTS = 32;
type Frame = Record<string, unknown>;
const unavailable = () => new Error('Bridge unavailable');
const cancelled = () => new Error('Bridge request cancelled');
const record = (value: unknown): value is Frame => !!value && typeof value === 'object' && !Array.isArray(value);

/** Byte-bounded newline framing: partial UTF-8 stays in the buffer until complete. */
function frames(socket: Socket, receive: (frame: Frame) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > PIPE_FRAME_BYTES) socket.destroy(); return; }
      if (end > PIPE_FRAME_BYTES) { socket.destroy(); return; }
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      try {
        const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!record(frame)) throw unavailable();
        receive(frame);
        if (socket.destroyed) return;
      } catch { socket.destroy(); return; }
    }
  });
}
function send(socket: Socket, frame: Frame): boolean {
  const line = JSON.stringify(frame);
  if (socket.destroyed || Buffer.byteLength(line) > PIPE_FRAME_BYTES
    || socket.writableLength > 2 * PIPE_FRAME_BYTES) { socket.destroy(); return false; }
  socket.write(`${line}\n`); return true;
}

export interface PipeExchangeClient {
  ask(input: unknown, signal?: AbortSignal): Promise<ExchangeResponse>;
  get(input: unknown, signal?: AbortSignal): Promise<ExchangeResponse>;
  cancel(input: unknown): Promise<ExchangeResponse>;
  markToolsListed(): void;
  close(): void;
}
export interface PipeServerOptions {
  endpoint?: string;
  capability: string;
  /** A main-owned facade already bound to its launch; never selected by client identity. */
  client: ExchangeClient;
  onAuthenticated?: () => void;
  onToolsListed?: () => void;
  onDisconnect?: () => void;
}
export async function startPipeServer(options: PipeServerOptions): Promise<{ endpoint: string; close(): Promise<void> }> {
  if (Buffer.byteLength(options.capability) < 32) throw new Error('Bridge capability too short');
  const nonce = randomBytes(16).toString('hex');
  const endpoint = options.endpoint ?? (process.platform === 'win32'
    ? `\\\\.\\pipe\\aether-bridge-${nonce}` : join(tmpdir(), `aether-bridge-${nonce}.sock`));
  const secret = Buffer.from(options.capability);
  const sockets = new Set<Socket>();
  let authenticated: Socket | undefined;
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    let authorized = false;
    let toolsListed = false;
    const pending = new Map<number, { method: string; input: unknown; abort: AbortController }>();
    const recentAsks = new Map<number, string>();
    const authTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => { /* No payloads, paths, or capability in diagnostics. */ });
    socket.on('close', () => {
      clearTimeout(authTimer); sockets.delete(socket);
      for (const item of pending.values()) item.abort.abort();
      pending.clear(); recentAsks.clear();
      if (authorized) {
        if (authenticated === socket) authenticated = undefined;
        try { options.onDisconnect?.(); } catch { /* Authority owns its shutdown handling. */ }
      }
    });
    frames(socket, frame => {
      if (!authorized) {
        const token = typeof frame.capability === 'string' ? Buffer.from(frame.capability) : Buffer.alloc(0);
        if (frame.type !== 'auth' || Object.keys(frame).length !== 2 || authenticated
          || token.length !== secret.length || !timingSafeEqual(token, secret)) { socket.destroy(); return; }
        authorized = true; authenticated = socket; clearTimeout(authTimer);
        if (send(socket, { type: 'ready' })) options.onAuthenticated?.();
        return;
      }
      if (frame.type === 'tools-listed' && Object.keys(frame).length === 1) {
        if (!toolsListed) { toolsListed = true; options.onToolsListed?.(); }
        return;
      }
      const id = frame.id;
      if (!Number.isSafeInteger(id) || (id as number) < 1) { socket.destroy(); return; }
      if (frame.type === 'abort' && Object.keys(frame).length === 2) {
        const item = pending.get(id as number);
        item?.abort.abort();
        const exchangeId = recentAsks.get(id as number);
        if (exchangeId) options.client.cancel({ exchange_id: exchangeId });
        recentAsks.delete(id as number); return;
      }
      if (frame.type !== 'call' || Object.keys(frame).length !== 4
        || !['ask', 'get', 'cancel'].includes(frame.method as string)
        || pending.has(id as number) || recentAsks.has(id as number) || pending.size >= MAX_REQUESTS) { socket.destroy(); return; }
      const method = frame.method as 'ask' | 'get' | 'cancel';
      const abort = new AbortController();
      pending.set(id as number, { method, input: frame.input, abort });
      // Calls are intentionally concurrent: a held get must never serialize cancel.
      void Promise.resolve().then(() => method === 'cancel' ? options.client.cancel(frame.input)
        : options.client[method](frame.input, abort.signal)).then(result => {
        if (method === 'ask' && 'exchange_id' in result && typeof result.exchange_id === 'string') {
          // Only an accepted result can authorize cancellation. Rejected keys may
          // alias an earlier job; never cancel that job via a rejected ask's input.
          if (abort.signal.aborted) options.client.cancel({ exchange_id: result.exchange_id });
          recentAsks.set(id as number, result.exchange_id);
          if (recentAsks.size > 64) recentAsks.delete(recentAsks.keys().next().value!);
        }
        send(socket, { type: 'result', id, result });
      }, () => { send(socket, { type: 'failure', id }); }).finally(() => pending.delete(id as number));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
  });
  let closing: Promise<void> | undefined;
  return { endpoint, close: () => closing ??= new Promise<void>((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  }) };
}

export async function connectPipeClient(options: { endpoint: string; capability: string; timeoutMs?: number }): Promise<PipeExchangeClient> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 90_000) throw unavailable();
  const socket = createConnection(options.endpoint);
  let ready = false, nextId = 0;
  type Pending = { resolve(value: ExchangeResponse): void; reject(error: Error): void; cleanup(): void };
  const pending = new Map<number, Pending>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Lazy connection plus a short operation stays within the two-second contract.
  const timer = setTimeout(() => socket.destroy(), Math.min(timeoutMs, 900));
  socket.on('connect', () => send(socket, { type: 'auth', capability: options.capability }));
  socket.on('error', () => { /* Close settles all callers with a safe generic error. */ });
  socket.on('close', () => {
    clearTimeout(timer); readyReject(unavailable());
    for (const item of pending.values()) { item.cleanup(); item.reject(unavailable()); }
    pending.clear();
  });
  frames(socket, frame => {
    if (!ready) {
      if (frame.type !== 'ready' || Object.keys(frame).length !== 1) { socket.destroy(); return; }
      ready = true; clearTimeout(timer); readyResolve(); return;
    }
    if (!Number.isSafeInteger(frame.id) || !['result', 'failure'].includes(frame.type as string)) { socket.destroy(); return; }
    const item = pending.get(frame.id as number);
    if (!item) return; // Late acknowledgement after this call was cancelled.
    pending.delete(frame.id as number); item.cleanup();
    if (frame.type === 'result' && record(frame.result)) item.resolve(frame.result as unknown as ExchangeResponse);
    else item.reject(unavailable());
  });
  await readiness;
  const call = (method: string, input: unknown, signal?: AbortSignal): Promise<ExchangeResponse> => {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (socket.destroyed || pending.size >= MAX_REQUESTS) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const stop = () => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id); item.cleanup(); send(socket, { type: 'abort', id }); reject(cancelled());
      };
      const deadline = setTimeout(stop, method === 'get' ? timeoutMs : Math.min(timeoutMs, 900));
      pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(deadline); signal?.removeEventListener('abort', stop); } });
      signal?.addEventListener('abort', stop, { once: true });
      send(socket, { type: 'call', id, method, input });
    });
  };
  let toolsListed = false;
  return { ask: (input, signal) => call('ask', input, signal), get: (input, signal) => call('get', input, signal),
    markToolsListed: () => {
      if (!toolsListed && send(socket, { type: 'tools-listed' })) toolsListed = true;
    },
    cancel: input => call('cancel', input), close: () => socket.destroy() };
}
