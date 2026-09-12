// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildSync } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ExchangeController } from './exchangeController';
import { createBridgeMcpServer } from './mcpServer';
import { startPipeServer } from './pipeServer';
import type { ProviderAdapter, TurnResult } from '../crossEngine/providers/contract';

let directory: string, entry: string;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'aether-mcp-test-')); entry = join(directory, 'helper.cjs');
  buildSync({ entryPoints: [resolve('electron/communicationBridge/mcpEntry.ts')], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function sdk(endpoint?: string, capability?: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe',
    env: { ...(endpoint ? { AETHER_BRIDGE_PIPE: endpoint } : {}), ...(capability ? { AETHER_BRIDGE_CAPABILITY: capability } : {}) } });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'u4-proof', version: '1.0.0' });
  await client.connect(transport); cleanup.push(() => client.close());
  return { client, transport, stderr: () => stderr };
}
function envelope(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as { type: string; text: string }[];
  expect(result.structuredContent).toBeUndefined(); expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text'); return JSON.parse(content[0].text);
}
async function fixture(options: { cleanupFails?: boolean } = {}) {
  let finish!: (result: TurnResult) => void;
  const turn = new Promise<TurnResult>(resolveTurn => { finish = resolveTurn; });
  const provider: ProviderAdapter = { id: 'fake', capabilities: vi.fn() as ProviderAdapter['capabilities'],
    connect: vi.fn(async () => {}), health: vi.fn(async () => ({ ready: true, authMode: 'subscription' as const, version: null, detail: '' })),
    newSession: vi.fn(async () => 's'), sendTurn: vi.fn(() => turn), cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => { if (options.cleanupFails) throw new Error('private diagnostic must not escape'); }) };
  const factory = vi.fn(() => provider);
  const controller = new ExchangeController({ providerFactory: factory,
    createWorkspace: async () => '/fake-private', removeWorkspace: async () => {} });
  controller.setEnabled(true); const scoped = controller.openLaunch();
  const client = { ...scoped, get: vi.fn(scoped.get) };
  const disconnected = vi.fn(() => controller.disconnect());
  const capability = randomBytes(32).toString('hex');
  const pipe = await startPipeServer({ capability, client, onDisconnect: disconnected });
  cleanup.push(async () => { await pipe.close();
    if (options.cleanupFails) await expect(controller.dispose()).rejects.toThrow('CLEANUP_FAILED');
    else await controller.dispose(); });
  const connection = await sdk(pipe.endpoint, capability);
  return { ...connection, controller, provider, factory, disconnected, finish, get: client.get };
}

describe('official SDK stdio bridge', () => {
  it('discovers exactly three bounded tools without main, then reports unavailable promptly', async () => {
    const f = await sdk(); const listed = await f.client.listTools();
    expect(listed.tools.map(t => t.name)).toEqual(['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange']);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.oneOf).toBeUndefined(); expect(tool.inputSchema.anyOf).toBeUndefined();
      expect(Buffer.byteLength(tool.description!)).toBeLessThan(2048);
      expect(tool._meta?.['anthropic/maxResultSizeChars']).toBe(40000);
    }
    const start = Date.now();
    const result = await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    expect(Date.now() - start).toBeLessThan(2000); expect(result.isError).toBe(true);
    expect(envelope(result)).toMatchObject({ schemaVersion: 1, code: 'NOT_CONNECTED' }); expect(f.stderr()).toBe('');
  });
  it('round trips fake provider final pages through stdio and authenticated pipe, without duplicate content', async () => {
    const f = await fixture(); await f.client.listTools(); expect(f.factory).not.toHaveBeenCalled();
    const asked = await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    expect(asked.isError).toBe(false); const accepted = envelope(asked);
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalledTimes(1));
    f.finish({ text: 'Advice "quoted"\n🧭'.repeat(1900), usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null }, stopReason: 'completed' });
    let cursor: string | undefined, answer = '';
    do {
      const result = await f.client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id: accepted.exchange_id, ...(cursor ? { cursor } : {}) } });
      expect(result.isError).toBe(false); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
      const page = envelope(result); answer += page.text; cursor = page.next_cursor;
    } while (cursor);
    expect(answer).toBe('Advice "quoted"\n🧭'.repeat(1900)); expect(f.stderr()).toBe('');
  });
  it('keeps a waiting get independent of cancel, and aborted get does not cancel the job', async () => {
    const f = await fixture();
    await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalled());
    const abort = new AbortController();
    const reading = f.client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'a', wait_ms: 60000 } }, undefined, { signal: abort.signal });
    const rejected = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(1)); abort.abort(); await rejected;
    expect(f.provider.cancel).not.toHaveBeenCalled();
    const waiting = f.client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'a', wait_ms: 60000 } });
    await vi.waitFor(() => expect(f.get).toHaveBeenCalledTimes(2));
    const start = Date.now(); const cancelled = await f.client.callTool({ name: 'cancel_codex_exchange', arguments: { request_key: 'a' } });
    expect(Date.now() - start).toBeLessThan(2000); expect(envelope(cancelled).provider_state).toMatch(/cancell/);
    expect(envelope(await waiting).provider_state).toMatch(/cancell/);
  });
  it('rejects unknown fields, wrong lookup exclusivity and UTF-8 overflow through the real handler', async () => {
    const f = await fixture();
    for (const args of [{ request_key: 'a', question: 'Q', launchId: 'spoof' },
      { request_key: 'a', question: '🧭'.repeat(4097) }]) {
      const result = await f.client.callTool({ name: 'ask_codex', arguments: args });
      expect(result.isError).toBe(true); expect(envelope(result).code).toMatch(/INVALID_INPUT|INPUT_LIMIT/);
    }
    for (const args of [{}, { request_key: 'a', exchange_id: 'b' }, { request_key: 'a', wait_ms: 0 }, { request_key: 'a', extra: true }]) {
      const result = await f.client.callTool({ name: 'get_codex_exchange', arguments: args });
      expect(result.isError).toBe(true); expect(envelope(result).code).toBe('INVALID_INPUT');
    }
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('EOF disconnects the authenticated scope and stops provider work', async () => {
    const f = await fixture(); await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalled());
    await f.client.close(); await vi.waitFor(() => expect(f.disconnected).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(f.provider.dispose).toHaveBeenCalledTimes(1));
  });
  it('classifies an actual bounded pending read as a successful status', async () => {
    const f = await fixture(); await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    const start = Date.now(); const result = await f.client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'a', wait_ms: 1000 } });
    expect(Date.now() - start).toBeGreaterThanOrEqual(950); expect(result.isError).toBe(false);
    expect(envelope(result)).toMatchObject({ delivery: { availability: 'pending' }, provider_state: 'waiting' });
  });
  it('rejects omitted tool arguments without disconnecting or cancelling an active exchange', async () => {
    const f = await fixture(); await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalled());
    for (const name of ['get_codex_exchange', 'cancel_codex_exchange', 'ask_codex']) {
      const result = await f.client.callTool({ name });
      expect(result.isError).toBe(true); expect(envelope(result).code).toBe('INVALID_INPUT');
    }
    expect(f.disconnected).not.toHaveBeenCalled(); expect(f.provider.cancel).not.toHaveBeenCalled();
    const recovered = await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    expect(recovered.isError).toBe(false); expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it('puts actionable terminal failure guidance in the actual SDK response', async () => {
    const f = await fixture(); await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalled());
    f.finish({ text: 'partial', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null }, stopReason: 'error' });
    const result = await f.client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'a' } });
    expect(result.isError).toBe(true);
    expect(envelope(result)).toMatchObject({ code: 'PROVIDER_FAILED', failure: 'PROVIDER_FAILED',
      guidance: 'The consultation did not complete successfully. Do not retry; the operator must decide whether to start another.' });
    expect(envelope(result).text).toBeUndefined();
  });
  it('preserves successful answer pages while explaining failed cleanup within the wrapper limit', async () => {
    const f = await fixture({ cleanupFails: true });
    await f.client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } });
    await vi.waitFor(() => expect(f.provider.sendTurn).toHaveBeenCalled());
    f.finish({ text: '\\"\n🧭'.repeat(8000), usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null }, stopReason: 'completed' });
    await vi.waitFor(() => expect(f.controller.metadata()[0].cleanup).toBe('failed'));
    const result = await f.client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'a' } });
    expect(result.isError).toBe(true); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
    expect(envelope(result)).toMatchObject({ code: 'CLEANUP_FAILED', provider_state: 'finished', availability: 'ready',
      status: { cleanup: 'failed' }, guidance: 'Codex produced this answer, but process cleanup was not confirmed. Do not retry; the operator must resolve cleanup in Aether before another consultation.' });
    expect(envelope(result).text.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });
  it('cancels an accepted ask when SDK cancellation arrives before acknowledgement returns', async () => {
    let release!: () => void;
    const accepted = new Promise<void>(resolveAccepted => { release = resolveAccepted; });
    const cancel = vi.fn(async () => ({ schemaVersion: 1 as const, code: 'CANCELLED' as const, guidance: 'Stopped' }));
    const ask = vi.fn(async (_input: unknown, signal?: AbortSignal) => {
      release(); await new Promise<void>(resolveAbort => signal!.addEventListener('abort', () => resolveAbort(), { once: true }));
      return { schemaVersion: 1, exchange_id: 'accepted' } as never;
    });
    const server = createBridgeMcpServer({ ask, get: vi.fn(), cancel });
    const client = new Client({ name: 'race', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    cleanup.push(async () => { await client.close(); await server.close(); });
    const abort = new AbortController();
    const call = client.callTool({ name: 'ask_codex', arguments: { request_key: 'a', question: 'Q' } }, undefined, { signal: abort.signal });
    const rejected = expect(call).rejects.toThrow(); await accepted; abort.abort(); await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ exchange_id: 'accepted' }));
  });
});
