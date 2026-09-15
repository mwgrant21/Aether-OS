// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectPipeClient, PIPE_FRAME_BYTES, startPipeServer } from './pipeServer';
import type { ExchangeClient, ExchangeResponse } from './exchangeController';
import { communicationError } from '../../src/shared/communicationLifecycle';

const capability = randomBytes(32).toString('hex');
const result = communicationError('BUSY');
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(overrides: Partial<ExchangeClient> = {}) {
  return { ask: vi.fn(() => result), get: vi.fn(async () => result), cancel: vi.fn(() => result), ...overrides };
}
async function open(client = fixture(), onDisconnect = vi.fn()) {
  const server = await startPipeServer({ capability, client, onDisconnect }); cleanup.push(() => server.close());
  const remote = await connectPipeClient({ endpoint: server.endpoint, capability }); cleanup.push(() => remote.close());
  return { server, remote, client, onDisconnect };
}
function raw(endpoint: string): Promise<Socket> {
  const socket = createConnection(endpoint); cleanup.push(() => { socket.destroy(); });
  socket.on('error', () => {});
  return new Promise(resolve => socket.once('connect', () => resolve(socket)));
}
function line(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let data = '';
    const handler = (part: Buffer) => { data += part.toString(); if (data.includes('\n')) {
      socket.removeListener('data', handler); resolve(JSON.parse(data.slice(0, data.indexOf('\n'))));
    } };
    socket.on('data', handler);
  });
}
describe('authenticated bridge pipe', () => {
  it('reports authentication separately from tools discovery, without provider calls', async () => {
    const client = fixture(), onAuthenticated = vi.fn(), onToolsListed = vi.fn();
    const server = await startPipeServer({ capability, client, onAuthenticated, onToolsListed });
    cleanup.push(() => server.close());
    const remote = await connectPipeClient({ endpoint: server.endpoint, capability });
    cleanup.push(() => remote.close());
    expect(onAuthenticated).toHaveBeenCalledTimes(1); expect(onToolsListed).not.toHaveBeenCalled();
    remote.markToolsListed(); remote.markToolsListed();
    await vi.waitFor(() => expect(onToolsListed).toHaveBeenCalledTimes(1));
    expect(client.ask).not.toHaveBeenCalled(); expect(client.get).not.toHaveBeenCalled(); expect(client.cancel).not.toHaveBeenCalled();
  });
  it.each(['unauthenticated', 'extra-field'])('rejects %s readiness notifications', async kind => {
    const onToolsListed = vi.fn();
    const server = await startPipeServer({ capability, client: fixture(), onToolsListed });
    cleanup.push(() => server.close());
    const socket = await raw(server.endpoint);
    if (kind === 'extra-field') {
      const ready = line(socket); socket.write(JSON.stringify({ type: 'auth', capability }) + '\n'); await ready;
    }
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write(JSON.stringify({ type: 'tools-listed', ...(kind === 'extra-field' ? { ready: true } : {}) }) + '\n');
    await closed; expect(onToolsListed).not.toHaveBeenCalled();
  });
  it('binds requests to the supplied authority; connect and reconnect cannot ask', async () => {
    const { remote, server, client, onDisconnect } = await open();
    expect(client.ask).not.toHaveBeenCalled();
    expect(await remote.ask({ request_key: 'a', question: 'hello' })).toEqual(result);
    expect(client.ask).toHaveBeenCalledTimes(1);
    remote.close(); await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    const second = await connectPipeClient({ endpoint: server.endpoint, capability }); cleanup.push(() => second.close());
    expect(client.ask).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong capability and caller-provided launch identity before invoking authority', async () => {
    const client = fixture(); const server = await startPipeServer({ capability, client }); cleanup.push(() => server.close());
    await expect(connectPipeClient({ endpoint: server.endpoint, capability: 'wrong' })).rejects.toThrow('Bridge unavailable');
    const socket = await raw(server.endpoint); const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write(JSON.stringify({ type: 'auth', capability, launchId: 'forged' }) + '\n'); await closed;
    expect(client.ask).not.toHaveBeenCalled();
  });
  it('handles partial UTF-8 frames and multiple messages in one write', async () => {
    const client = fixture(); const server = await startPipeServer({ capability, client }); cleanup.push(() => server.close());
    const socket = await raw(server.endpoint); const ready = line(socket);
    const auth = JSON.stringify({ type: 'auth', capability }) + '\n'; socket.write(auth.slice(0, 12)); socket.write(auth.slice(12));
    expect(await ready).toEqual({ type: 'ready' });
    const reply = line(socket); const message = Buffer.from(JSON.stringify({ type: 'call', id: 1, method: 'ask', input: { question: '🌙' } }) + '\n');
    const split = message.indexOf(Buffer.from('🌙')) + 1; socket.write(message.subarray(0, split)); socket.write(message.subarray(split));
    expect((await reply).type).toBe('result'); expect(client.ask).toHaveBeenCalledWith({ question: '🌙' }, expect.any(AbortSignal));
    socket.write(JSON.stringify({ type: 'call', id: 2, method: 'cancel', input: {} }) + '\n' + JSON.stringify({ type: 'call', id: 3, method: 'cancel', input: {} }) + '\n');
    await vi.waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(2));
  });
  it.each(['invalid', 'oversized', 'invalid-utf8'])('closes %s framing without executing requests', async kind => {
    const client = fixture(); const server = await startPipeServer({ capability, client }); cleanup.push(() => server.close());
    const socket = await raw(server.endpoint); const closed = new Promise(resolve => socket.once('close', resolve));
    socket.write(kind === 'invalid' ? 'bad\n' : kind === 'oversized' ? Buffer.alloc(PIPE_FRAME_BYTES + 1, 65) : Buffer.from([0xff, 10]));
    await closed; expect(client.ask).not.toHaveBeenCalled();
  });
  it('processes cancel while get waits, and aborts only the selected get', async () => {
    const signals: AbortSignal[] = [];
    const client = fixture({ get: vi.fn((_input, signal) => new Promise<ExchangeResponse>(resolve => {
      signals.push(signal!); signal!.addEventListener('abort', () => resolve(result), { once: true });
    })) });
    const { remote } = await open(client);
    const abort = new AbortController(); const first = remote.get({}, abort.signal); const rejected = expect(first).rejects.toThrow('cancelled');
    const followerAbort = new AbortController(); const follower = remote.get({}, followerAbort.signal); const followerRejected = expect(follower).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(await remote.cancel({ request_key: 'a' })).toEqual(result);
    abort.abort(); await rejected; await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
    expect(signals[1].aborted).toBe(false); expect(client.cancel).toHaveBeenCalledTimes(1);
    followerAbort.abort(); await followerRejected;
  });
  it.each([true, false])('coalesced abort cancels only an accepted ask (accepted=%s)', async accepted => {
    const client = fixture({ ask: vi.fn(() => accepted ? { ...result, exchange_id: 'accepted-id' } as ExchangeResponse : communicationError('KEY_CONFLICT')) });
    const server = await startPipeServer({ capability, client }); cleanup.push(() => server.close());
    const socket = await raw(server.endpoint); const ready = line(socket); socket.write(JSON.stringify({ type: 'auth', capability }) + '\n'); await ready;
    socket.write(JSON.stringify({ type: 'call', id: 1, method: 'ask', input: { request_key: 'lost', question: 'hi' } }) + '\n' + JSON.stringify({ type: 'abort', id: 1 }) + '\n');
    await vi.waitFor(() => expect(client.ask).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.ask).mock.calls[0][1]?.aborted).toBe(true);
    if (accepted) expect(client.cancel).toHaveBeenCalledWith({ exchange_id: 'accepted-id' });
    else expect(client.cancel).not.toHaveBeenCalled();
  });
  it('EOF aborts outstanding reads and notifies main once', async () => {
    let signal: AbortSignal | undefined;
    const { remote, onDisconnect } = await open(fixture({ get: (_input, value) => new Promise(resolve => {
      signal = value; value!.addEventListener('abort', () => resolve(result));
    }) }));
    const waiting = remote.get({}); const rejected = expect(waiting).rejects.toThrow('Bridge unavailable');
    await vi.waitFor(() => expect(signal).toBeDefined()); remote.close(); await rejected;
    await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1)); expect(signal!.aborted).toBe(true);
  });
  it('bounds a silent main handshake and an unavailable endpoint', async () => {
    const name = randomBytes(8).toString('hex'); const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\u4-silent-${name}` : join(tmpdir(), `u4-${name}.sock`);
    const sockets: Socket[] = []; const server = createServer(socket => { sockets.push(socket); socket.resume(); });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    cleanup.push(() => new Promise<void>(resolve => { sockets.forEach(s => s.destroy()); server.close(() => resolve()); }));
    const started = Date.now();
    await expect(connectPipeClient({ endpoint, capability })).rejects.toThrow('Bridge unavailable');
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(connectPipeClient({ endpoint: endpoint + '-missing', capability, timeoutMs: 30 })).rejects.toThrow('Bridge unavailable');
  });
  it('bounds short calls with production defaults while an independent get remains waiting', async () => {
    const name = randomBytes(8).toString('hex'); const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\u4-held-${name}` : join(tmpdir(), `u4-${name}.sock`);
    const sockets: Socket[] = [];
    const server = createServer(socket => {
      sockets.push(socket);
      socket.once('data', () => socket.write('{"type":"ready"}\n'));
      socket.on('data', () => {});
    });
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    cleanup.push(() => new Promise<void>(resolve => { sockets.forEach(s => s.destroy()); server.close(() => resolve()); }));
    const remote = await connectPipeClient({ endpoint, capability }); cleanup.push(() => remote.close());
    const abort = new AbortController(); let getReturned = false;
    const get = remote.get({}, abort.signal).finally(() => { getReturned = true; });
    const getRejected = expect(get).rejects.toThrow('cancelled');
    const started = Date.now();
    await Promise.all([
      expect(remote.ask({ request_key: 'held', question: 'hi' })).rejects.toThrow('cancelled'),
      expect(remote.cancel({ request_key: 'held' })).rejects.toThrow('cancelled'),
    ]);
    expect(Date.now() - started).toBeLessThan(2000); expect(getReturned).toBe(false);
    abort.abort(); await getRejected;
  });
});
