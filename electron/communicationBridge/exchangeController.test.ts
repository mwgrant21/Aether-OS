// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeController, buildAnswerPages } from './exchangeController';
import type { ProviderAdapter, ProviderEvent, TurnResult } from '../crossEngine/providers/contract';
import type { CommunicationStatusV1 } from '../../src/shared/communicationTypes';

function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const usage = { inputTokens: null, outputTokens: null, cachedInputTokens: null };
function fixture() {
  const turns: ReturnType<typeof deferred<TurnResult>>[] = [];
  const events: ((e: ProviderEvent) => void)[] = [];
  const adapters: ProviderAdapter[] = [];
  const createWorkspace = vi.fn(async () => '/private/empty');
  const removeWorkspace = vi.fn(async () => {});
  const factory = vi.fn(() => {
    const turn = deferred<TurnResult>(); turns.push(turn);
    const provider: ProviderAdapter = {
      id: 'fake', capabilities: vi.fn() as ProviderAdapter['capabilities'], connect: vi.fn(async () => {}),
      health: vi.fn(async () => ({ ready: true, authMode: 'subscription' as const, version: null, detail: '' })),
      newSession: vi.fn(async () => 'session'),
      sendTurn: vi.fn((_r, callback) => { events.push(callback); return turn.promise; }),
      cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    };
    adapters.push(provider); return provider;
  });
  const controller = new ExchangeController({ providerFactory: factory, createWorkspace, removeWorkspace });
  controller.setEnabled(true); const client = controller.openLaunch();
  const ask = (n = 0) => client.ask({ request_key: `k${n}`, question: `Question ${n}` }) as CommunicationStatusV1;
  const complete = async (text = 'Answer', i = 0) => {
    turns[i].resolve({ text, usage, stopReason: 'completed' }); await flush();
  };
  return { controller, client, ask, complete, factory, adapters, events, createWorkspace, removeWorkspace, turns };
}
async function flush() { for (let n = 0; n < 25; n++) await Promise.resolve(); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('bounded exchange authority and delivery', () => {
  it('reserves synchronously and recovers lost acknowledgements without starting twice', async () => {
    const f = fixture(); const a = f.ask(); expect(a.provider_state).toBe('accepted'); expect(a.credits.reserved).toBe(1);
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.ask().exchange_id).toBe(a.exchange_id);
    expect(f.client.ask({ request_key: 'alias', question: 'Question 0' })).toMatchObject({ exchange_id: a.exchange_id });
    await vi.runAllTicks(); await flush(); expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.adapters[0].newSession).toHaveBeenCalledWith({ cwd: '/private/empty' });
    await f.complete();
    expect(await f.client.get({ request_key: 'alias' })).toMatchObject({ text: 'Answer' });
    expect(f.controller.metadata()[0].delivery.uniquePagesServed).toBe(1);
  });
  it('waits 45/60 seconds through chunks and phase updates, then reports measured progress', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    let returned = false;
    const waiting = f.client.get({ exchange_id: a.exchange_id }).then(r => { returned = true; return r; });
    await vi.advanceTimersByTimeAsync(20_000);
    f.events[0]({ kind: 'message-chunk', sessionId: 'session', text: 'abc' }); await flush(); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toMatchObject({ elapsed_ms: 45_000, observed_output_bytes: 3, last_output_at: 1_020_000, provider_state: 'streaming' });
    const second = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000); expect(await second).toMatchObject({ elapsed_ms: 105_000 });
    f.controller.disconnect(); await flush();
  });
  it('keeps one owner, never promotes followers, and permits a new owner after abort', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    const abort = new AbortController();
    const owner = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 }, abort.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const follower = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
    abort.abort(); expect(await owner).toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(20_000);
    const newOwner = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
    expect(f.controller.metadata()[0].leaseExpiresAt).toBe(1_120_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await follower).toMatchObject({ lease_expires_at: 1_120_000 });
    await f.complete(); expect(await newOwner).toMatchObject({ text: 'Answer' });
  });
  it('followers cannot renew an interrupted owner lease and all hear lease cancellation', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    const abort = new AbortController();
    const owner = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 }, abort.signal);
    await vi.advanceTimersByTimeAsync(50_000);
    const follower = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
    abort.abort(); await owner;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await follower).toMatchObject({ provider_state: 'cancelling' });
    await flush(); expect(f.controller.metadata()[0]).toMatchObject({ failure: 'LEASE_EXPIRED', cleanup: 'confirmed' });
  });
  it('caps waiters at 16, broadcasts terminal pages, and counts replay once', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    const waits = Array.from({ length: 16 }, () => f.client.get({ exchange_id: a.exchange_id }));
    expect(await f.client.get({ exchange_id: a.exchange_id })).toMatchObject({ code: 'READ_CAPACITY' });
    await f.complete('Same page');
    expect((await Promise.all(waits)).every(r => 'text' in r && r.text === 'Same page')).toBe(true);
    expect(f.controller.metadata()[0].delivery.uniquePagesServed).toBe(1);
  });
  it('hard deadline stops a five-minute turn despite repeated owner waits', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    for (let i = 0; i < 4; i++) { const wait = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000); expect(await wait).toMatchObject({ deadline_at: 1_300_000 }); }
    const last = f.client.get({ exchange_id: a.exchange_id, wait_ms: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000); await last; await flush();
    expect(f.controller.metadata()[0]).toMatchObject({ providerState: 'timed-out', failure: 'TIMEOUT' });
  });
  it('cancels before startup and refunds without constructing a provider', async () => {
    const f = fixture(), a = f.ask(); f.client.cancel({ exchange_id: a.exchange_id });
    await vi.runAllTicks(); await flush(); expect(f.factory).not.toHaveBeenCalled();
    expect(await f.client.get({ exchange_id: a.exchange_id })).toMatchObject({ provider_state: 'cancelled', remaining_credits: 3 });
  });
  it('holds the slot until a late workspace resolves and is removed after cancellation', async () => {
    const f = fixture(), dir = deferred<string>(); f.createWorkspace.mockReturnValueOnce(dir.promise);
    const a = f.ask(); await vi.runAllTicks(); await flush(); f.client.cancel({ exchange_id: a.exchange_id });
    await vi.advanceTimersByTimeAsync(31_000); expect(f.ask(1)).toMatchObject({ code: 'BUSY' });
    dir.resolve('/late'); await flush(); expect(f.removeWorkspace).toHaveBeenCalledWith('/late'); expect(f.factory).not.toHaveBeenCalled();
  });
  it('keeps cleanup pending and blocks reuse after success until real disposal resolves', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    const disposal = deferred<void>(); vi.mocked(f.adapters[0].dispose).mockReturnValue(disposal.promise);
    await f.complete(); expect(await f.client.get({ exchange_id: a.exchange_id })).toMatchObject({ text: 'Answer' });
    expect(f.controller.metadata()[0].cleanup).toBe('pending'); expect(f.ask(1)).toMatchObject({ code: 'BUSY' });
    disposal.resolve(); await flush(); expect(f.controller.metadata()[0].cleanup).toBe('confirmed');
  });
  it('does not reuse a failed cleanup slot across launch replacement or disable', async () => {
    const f = fixture(); f.ask(); await vi.runAllTicks(); await flush();
    vi.mocked(f.adapters[0].dispose).mockRejectedValue(new Error('sensitive failure'));
    await f.complete(); expect(f.controller.metadata()[0].cleanup).toBe('failed');
    f.controller.setEnabled(false); f.controller.setEnabled(true);
    expect(f.controller.openLaunch().ask({ request_key: 'new', question: 'other' })).toMatchObject({ code: 'BUSY' });
  });
  it('retains completed content across lease expiry/disconnect and clears exactly at retention', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush(); await f.complete();
    f.controller.disconnect(); await vi.advanceTimersByTimeAsync(599_999);
    expect(f.controller.readPayload(a.exchange_id)?.answer).toBe('Answer');
    await vi.advanceTimersByTimeAsync(1); expect(f.controller.readPayload(a.exchange_id)).toBeUndefined();
  });
  it.each(['connect', 'health', 'newSession'] as const)('cancels during %s without a later submission', async stage => {
    const f = fixture(), late = deferred<never>();
    const original = f.factory.getMockImplementation()!;
    f.factory.mockImplementation(() => { const provider = original();
      vi.mocked(provider[stage]).mockImplementation(() => late.promise); return provider; });
    const a = f.ask(); await vi.runAllTicks(); await flush();
    f.client.cancel({ exchange_id: a.exchange_id }); await flush();
    expect(f.adapters[0].dispose).toHaveBeenCalledTimes(1);
    expect(f.adapters[0].sendTurn).not.toHaveBeenCalled();
    expect(await f.client.get({ exchange_id: a.exchange_id })).toMatchObject({ remaining_credits: 3, cleanup: 'confirmed' });
    late.resolve(undefined as never); await flush(); expect(f.adapters[0].sendTurn).not.toHaveBeenCalled();
  });
  it('enforces three starts and idempotent operator grants without resetting cooldown or tombstones', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) { expect(f.ask(i)).toMatchObject({ provider_state: 'accepted' });
      await vi.runAllTicks(); await flush(); await f.complete('ok', i); }
    expect(f.ask(3)).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    f.controller.grantCredits('confirmed'); f.controller.grantCredits('confirmed');
    expect(f.ask(3)).toMatchObject({ code: 'COOLDOWN' });
    expect(f.ask(0)).toMatchObject({ remaining_credits: 3, credits: { granted: 6, consumed: 3 } });
    await vi.advanceTimersByTimeAsync(30_000); expect(f.ask(3)).toMatchObject({ provider_state: 'accepted' });
    await f.controller.dispose();
  });
  it('already-aborted reads do not renew lease and UI reads cannot renew it', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    await vi.advanceTimersByTimeAsync(50_000);
    const abort = new AbortController(); abort.abort();
    expect(await f.client.get({ exchange_id: a.exchange_id }, abort.signal)).toMatchObject({ code: 'CANCELLED' });
    f.controller.readPayload(a.exchange_id); expect(f.controller.metadata()[0].leaseExpiresAt).toBe(1_090_000);
    await vi.advanceTimersByTimeAsync(40_000); expect(f.controller.metadata()[0].failure).toBe('LEASE_EXPIRED');
  });
  it('retains bounded partial output while rejecting an oversized stream and handles split surrogates', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    f.events[0]({ kind: 'message-chunk', sessionId: 'session', text: '\ud83d' });
    f.events[0]({ kind: 'message-chunk', sessionId: 'session', text: '\ude00' });
    expect(f.controller.metadata()[0].observedOutputBytes).toBe(4);
    const wait = f.client.get({ exchange_id: a.exchange_id });
    f.events[0]({ kind: 'message-chunk', sessionId: 'session', text: 'a'.repeat(65_536) });
    expect(await wait).toMatchObject({ provider_state: 'cancelling' }); await flush();
    expect(f.controller.metadata()[0].failure).toBe('OUTPUT_LIMIT');
    expect(f.controller.readPayload(a.exchange_id)?.answer).toBe('😀');
  });
  it('exposes cleanup and current credits in answer pages within the outer MCP envelope', async () => {
    const f = fixture(), a = f.ask(); await vi.runAllTicks(); await flush();
    vi.mocked(f.adapters[0].dispose).mockRejectedValue(new Error('cleanup'));
    await f.complete('\u0000'.repeat(65_536));
    const page = await f.client.get({ exchange_id: a.exchange_id });
    expect(page).toMatchObject({ status: { cleanup: 'failed', remaining_credits: 2 } });
    expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(page) }] }))).toBeLessThanOrEqual(32 * 1024);
    await expect(f.controller.dispose()).rejects.toThrow('CLEANUP_FAILED');
  });
  it('fresh reads after cancellation wait for cleanup progress instead of repeatedly waking', async () => {
    const f = fixture(), dir = deferred<string>(); f.createWorkspace.mockReturnValueOnce(dir.promise);
    const a = f.ask(); await vi.runAllTicks(); await flush();
    f.client.cancel({ exchange_id: a.exchange_id }); let returned = false;
    const wait = f.client.get({ exchange_id: a.exchange_id, wait_ms: 1000 }).then(r => { returned = true; return r; });
    await vi.advanceTimersByTimeAsync(999); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await wait).toMatchObject({ provider_state: 'cancelling' });
    dir.resolve('/late'); await flush();
  });
  it('reports workspace removal failure and keeps the slot unavailable', async () => {
    const f = fixture(); f.removeWorkspace.mockRejectedValue(new Error('private path'));
    f.ask(); await vi.runAllTicks(); await flush(); await f.complete();
    expect(f.controller.metadata()[0].cleanup).toBe('failed'); expect(f.ask(1)).toMatchObject({ code: 'BUSY' });
    await expect(f.controller.dispose()).rejects.toThrow('CLEANUP_FAILED');
  });
  it('paginates Unicode and escaping-heavy answers with byte-exact stable envelopes', () => {
    for (const answer of ['😀'.repeat(16_384), '\u0000'.repeat(65_536), '"\\\n'.repeat(20_000)]) {
      const pages = buildAnswerPages('id', answer, 'version');
      expect(pages.map(p => p.text).join('')).toBe(answer);
      for (const p of pages) { expect(Buffer.byteLength(p.text)).toBeLessThanOrEqual(24 * 1024);
        expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(32 * 1024); }
      expect(buildAnswerPages('id', answer, 'version')).toEqual(pages);
    }
  });
});
