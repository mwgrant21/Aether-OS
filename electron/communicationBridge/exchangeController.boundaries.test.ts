// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeController, type ExchangeResponse } from './exchangeController';
import { FakeProvider } from '../crossEngine/providers/fakeProvider';
import { EMPTY_USAGE, type ProviderAdapter } from '../crossEngine/providers/contract';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function accepted(response: ExchangeResponse): string {
  expect(response).toHaveProperty('exchange_id');
  return (response as { exchange_id: string }).exchange_id;
}
describe('exchange controller independent boundaries', () => {
  const controllers: ExchangeController[] = [];
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); vi.setSystemTime(1000); });
  afterEach(async () => { for (const controller of controllers.splice(0)) controller.setEnabled(false); await flush(); vi.useRealTimers(); });
  function setup(factory: () => ProviderAdapter) {
    const remove = vi.fn(async () => {});
    const controller = new ExchangeController({ providerFactory: factory,
      createWorkspace: async () => 'C:/fake-private', removeWorkspace: remove });
    controllers.push(controller); controller.setEnabled(true);
    return { controller, client: controller.openLaunch(), remove };
  }

  it('rejects an oversized final-only answer without ever serving a success page', async () => {
    const provider = new FakeProvider();
    provider.sendTurn = async () => ({ stopReason: 'completed', text: 'x'.repeat(65 * 1024), usage: EMPTY_USAGE });
    const { controller, client } = setup(() => provider);
    const id = accepted(client.ask({ request_key: 'cap', question: 'q' }));
    await flush();
    expect(await client.get({ exchange_id: id })).toMatchObject({ failure: 'OUTPUT_LIMIT' });
    expect(controller.readPayload(id)?.answer).toBe('');
    expect(controller.metadata()[0].observedOutputBytes).toBeNull();
  });

  it('requires subscription health even when a provider claims ready', async () => {
    const provider = new FakeProvider({ health: { ready: true, authMode: 'api-key' } });
    const send = vi.spyOn(provider, 'sendTurn');
    const { client, remove } = setup(() => provider);
    const id = accepted(client.ask({ request_key: 'auth', question: 'q' }));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(await client.get({ exchange_id: id })).toMatchObject({ provider_state: 'failed', remaining_credits: 3 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns the cooldown deadline and available credit with a rejected ask', () => {
    const { client } = setup(() => new FakeProvider());
    expect(client.ask({ request_key: 'invalid', question: '' })).toMatchObject({ code: 'INVALID_INPUT' });
    expect(client.ask({ request_key: 'valid', question: 'q' })).toMatchObject({
      code: 'COOLDOWN', next_eligible_at: 31_000, remaining_credits: 3,
    });
  });

  it('keeps a successful answer readable while surfacing cleanup failure and blocking another start', async () => {
    const provider = new FakeProvider({ chunks: ['answer survived'] });
    provider.dispose = async () => { throw new Error('private failure detail'); };
    const { client } = setup(() => provider);
    const id = accepted(client.ask({ request_key: 'cleanup', question: 'q' })); await flush();
    const response = await client.get({ exchange_id: id });
    expect(response).toMatchObject({ text: 'answer survived', status: { cleanup: 'failed', remaining_credits: 2 } });
    expect(JSON.stringify(response)).not.toContain('private failure detail');
    expect(client.ask({ request_key: 'second', question: 'another' })).toMatchObject({ code: 'BUSY' });
  });

  it('revokes replaced launch access while retaining its answer for main-only Comms reads', async () => {
    const { controller, client } = setup(() => new FakeProvider({ chunks: ['retained answer'] }));
    const id = accepted(client.ask({ request_key: 'old', question: 'q' }));
    await flush();
    const replacement = controller.openLaunch();
    expect(await client.get({ exchange_id: id })).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(await replacement.get({ exchange_id: id })).toMatchObject({ code: 'UNKNOWN_EXCHANGE' });
    expect(controller.readPayload(id)?.answer).toBe('retained answer');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(controller.readPayload(id)).toBeUndefined();
  });

  it('does not evict retained answers when record or payload reservations fill', async () => {
    const { controller, client } = setup(() => new FakeProvider({ chunks: ['answer'] }));
    let first = '';
    let rejection: ExchangeResponse | undefined;
    for (let i = 0; i < 21; i++) {
      controller.grantCredits(`grant_${i}`);
      const response = client.ask({ request_key: `key_${i}`, question: `question ${i}` });
      if ('code' in response) { rejection = response; break; }
      const id = accepted(response); if (!first) first = id;
      await flush();
    }
    expect(rejection).toMatchObject({ code: 'RETENTION_FULL' });
    expect(controller.readPayload(first)?.answer).toBe('answer');
    expect(controller.metadata().length).toBeLessThanOrEqual(20);
    expect(await client.get({ exchange_id: first })).toMatchObject({ text: 'answer' });
  });

  it('bounds and replays escaped Unicode pages without altering the authoritative answer', async () => {
    const answer = '\u0000"\\😀'.repeat(5000);
    const provider = new FakeProvider();
    provider.sendTurn = async () => ({ stopReason: 'completed', text: answer, usage: EMPTY_USAGE });
    const { client, controller } = setup(() => provider);
    const id = accepted(client.ask({ request_key: 'pages', question: 'q' })); await flush();
    let cursor: string | undefined; let recovered = ''; let count = 0;
    do {
      const page = await client.get({ exchange_id: id, ...(cursor ? { cursor } : {}) });
      expect(page).toHaveProperty('text');
      if (!('text' in page)) throw new Error('Expected page');
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(page) }] }))).toBeLessThanOrEqual(32768);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(24576);
      expect(await client.get({ exchange_id: id, cursor: page.cursor })).toEqual(page);
      recovered += page.text; count++; cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(count).toBeGreaterThan(1); expect(recovered).toBe(answer);
    expect(controller.metadata()[0].delivery.uniquePagesServed).toBe(count);
  });
});
