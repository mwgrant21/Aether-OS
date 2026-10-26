// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createControlHub, PEER_BINDING_ENFORCED, AUTO_ENABLE_MAX_RETRIES, AUTO_ENABLE_RETRY_MS, CONTROL_REVOKE_UNSAVED_NOTICE } from './controlHub';
import { createDeviceAuth } from '../remote/remoteAuth';
import type { StoredSession } from '../remote/types';
import { CONTROL_CTL_MAX_PAYLOAD, CONTROL_HELLO_TIMEOUT_MS } from '../../src/shared/remote/types';
import type { ControlSocket, ListenerPort, RemoteUnavailableReason, TerminalReadPort, TerminalSlotId } from '../../src/shared/remote/types';

const helloFrame: string = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../protocol/mobile-protocol.json'), 'utf8')).frames.hello;
const PEER = '100.94.15.125';
const ADDR = '100.84.175.105:47821';
const tick = () => new Promise<void>(r => setImmediate(r));

function fakeStore() {
  const saved: StoredSession[][] = [];
  const s = {
    failSave: false,
    saved,
    load: (): StoredSession[] => [],
    save: async (list: StoredSession[]): Promise<void> => {
      if (s.failSave) throw new Error('disk');
      saved.push(JSON.parse(JSON.stringify(list)));
    },
  };
  return s;
}

function fakeSocket(): ControlSocket & { sent: string[]; closes: number[]; drop(): void; feed(t: string): void } {
  let onClose: () => void = () => {};
  let onMsg: (t: string) => void = () => {};
  const s = {
    sent: [] as string[],
    closes: [] as number[],
    send: (t: string) => { s.sent.push(t); },
    close: (c: number) => { s.closes.push(c); },
    bufferedBytes: () => 0,
    onMessage: (cb: (t: string) => void) => { onMsg = cb; },
    feed: (t: string) => onMsg(t),
    onClose: (cb: () => void) => { onClose = cb; },
    drop: () => onClose(),
  };
  return s;
}

/** Read-port stub that counts retains and releases; release is idempotent like the real one unless throwOnRelease is set. */
function fakeTerminals(opts: { throwOnRetain?: boolean; throwOnRelease?: boolean } = {}) {
  const t = { retains: 0, releases: 0 };
  const port: TerminalReadPort = {
    list: () => [],
    attach: () => ({ detach: () => {} }),
    onState: () => () => {},
    retain: () => {
      if (opts.throwOnRetain) throw new Error('retain failed');
      t.retains += 1;
      return () => {
        t.releases += 1;
        if (opts.throwOnRelease) throw new Error('release failed');
      };
    },
  };
  return { port, t };
}

function setup(over: { acquire?: ListenerPort['acquire']; flag?: boolean; confirm?: (peer: string | null, replaces: boolean) => Promise<boolean>; terminals?: ReturnType<typeof fakeTerminals> } = {}) {
  const terms = over.terminals ?? fakeTerminals();
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const listener = {
    acquire: vi.fn(over.acquire ?? (async () => ({ ok: true as const, address: ADDR }))),
    release: vi.fn(async () => {}),
    address: vi.fn(() => ADDR),
    closeControlClients: vi.fn(),
    recheckControl: vi.fn(),
    onControlClients: vi.fn(),
  };
  const settings = { flag: over.flag ?? false, read: vi.fn(() => settings.flag), persist: vi.fn((on: boolean) => { settings.flag = on; return settings.flag; }) };
  const store = fakeStore();
  const confirmPair = vi.fn(over.confirm ?? (async () => true));
  const logs: string[] = [];
  const writes: string[] = [];
  const hub = createControlHub({
    listener, store, settings, confirmPair,
    terminals: terms.port,
    input: { write: (s: TerminalSlotId, d: string) => { writes.push(`${s}|${d}`); return true; } },
    renderQr: t => `<svg>${t.length}</svg>`,
    log: l => { logs.push(l); },
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimeoutFn: h => { const i = timers.findIndex(t => t.id === h); if (i >= 0) timers.splice(i, 1); },
    retryMs: 1000,
  });
  return { hub, listener, settings, store, confirmPair, timers, logs, writes, terms: terms.t };
}

async function pairOne(hub: ReturnType<typeof setup>['hub']) {
  const made = await hub.createPairing();
  if (!made.ok) throw new Error('no pairing');
  const r = await hub.port.pair(made.code, PEER);
  if (r.status !== 200) throw new Error(`pair ${r.status}`);
  return r;
}

describe('control hub enable/disable', () => {
  it('enables on the shared listener and reports the address', async () => {
    const { hub, listener } = setup();
    const s = await hub.setEnabled(true);
    expect(listener.acquire).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ state: 'on', address: ADDR, reason: null, connected: 0 });
  });

  it('reports unavailable with the reason and leaves the flag alone when the listener cannot start', async () => {
    const reason: RemoteUnavailableReason = 'port-in-use';
    const { hub, settings } = setup({ acquire: async () => ({ ok: false, reason }), flag: true });
    const s = await hub.setEnabled(true);
    expect(s).toMatchObject({ state: 'unavailable', reason: 'port-in-use', address: null });
    expect(settings.persist).not.toHaveBeenCalled();
    expect(settings.flag).toBe(true);
  });

  it('a user disable clears the persisted re-enable flag, closes clients and releases the listener', async () => {
    const { hub, listener, settings } = setup({ flag: true });
    await hub.setEnabled(true);
    const s = await hub.setEnabled(false);
    expect(settings.persist).toHaveBeenCalledWith(false);
    expect(settings.flag).toBe(false);
    expect(listener.closeControlClients).toHaveBeenCalledWith('disabled');
    expect(listener.release).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ state: 'off', reenableAtLaunch: false });
  });

  it('a disable does not revoke devices', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    await pairOne(hub);
    const s = await hub.setEnabled(false);
    expect(s.devices).toHaveLength(1);
  });

  it('quit (stop) leaves the persisted flag set and never writes settings', async () => {
    const { hub, listener, settings } = setup({ flag: true });
    await hub.setEnabled(true);
    await hub.stop();
    expect(settings.persist).not.toHaveBeenCalled();
    expect(settings.flag).toBe(true);
    expect(listener.release).toHaveBeenCalledTimes(1);
    expect(listener.closeControlClients).toHaveBeenCalledWith('disabled');
  });

  it('setReenableAtLaunch reports the readback, not the requested value, and only while on', async () => {
    const { hub, settings } = setup();
    expect((await hub.setReenableAtLaunch(true)).reenableAtLaunch).toBe(false);
    expect(settings.persist).not.toHaveBeenCalled(); // not on yet
    await hub.setEnabled(true);
    settings.persist.mockImplementationOnce(() => false); // the write silently failed
    expect((await hub.setReenableAtLaunch(true)).reenableAtLaunch).toBe(false);
    expect((await hub.setReenableAtLaunch(true)).reenableAtLaunch).toBe(true);
  });
});

describe('control hub autoEnable', () => {
  it('acquires without a confirm or a flag write when the flag is set', async () => {
    const { hub, listener, settings, confirmPair } = setup({ flag: true });
    await hub.autoEnable();
    expect(listener.acquire).toHaveBeenCalledTimes(1);
    expect(hub.status()).toMatchObject({ state: 'on', reenableAtLaunch: true });
    expect(settings.persist).not.toHaveBeenCalled();
    expect(confirmPair).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is false', async () => {
    const { hub, listener } = setup({ flag: false });
    await hub.autoEnable();
    expect(listener.acquire).not.toHaveBeenCalled();
    expect(hub.status().state).toBe('off');
  });

  it('retries a missing tailnet address 10 times, 30 s apart, then stays unavailable with the flag intact', async () => {
    const { hub, listener, settings, timers } = setup({ flag: true, acquire: async () => ({ ok: false, reason: 'no-tailnet-address' }) });
    await hub.autoEnable();
    expect(listener.acquire).toHaveBeenCalledTimes(1);
    for (let i = 0; i < AUTO_ENABLE_MAX_RETRIES; i++) {
      expect(timers).toHaveLength(1);
      expect(timers[0].ms).toBe(AUTO_ENABLE_RETRY_MS);
      timers.shift()!.fn();
      await tick();
    }
    expect(listener.acquire).toHaveBeenCalledTimes(1 + AUTO_ENABLE_MAX_RETRIES);
    expect(timers).toHaveLength(0);
    expect(hub.status()).toMatchObject({ state: 'unavailable', reason: 'no-tailnet-address', reenableAtLaunch: true });
    expect(settings.persist).not.toHaveBeenCalled();
  });

  it('does not retry other failures', async () => {
    const { hub, listener, timers } = setup({ flag: true, acquire: async () => ({ ok: false, reason: 'port-in-use' }) });
    await hub.autoEnable();
    expect(timers).toHaveLength(0);
    expect(listener.acquire).toHaveBeenCalledTimes(1);
  });

  it('a manual enable cancels the pending retry', async () => {
    let up = false;
    const { hub, timers, listener } = setup({
      flag: true,
      acquire: async () => (up ? { ok: true as const, address: ADDR } : { ok: false as const, reason: 'no-tailnet-address' as const }),
    });
    await hub.autoEnable();
    expect(timers).toHaveLength(1);
    up = true;
    await hub.setEnabled(true);
    expect(timers).toHaveLength(0);
    expect(hub.status().state).toBe('on');
    expect(listener.acquire).toHaveBeenCalledTimes(2);
  });

  it('stop leaves no retry timer behind', async () => {
    const { hub, timers } = setup({ flag: true, acquire: async () => ({ ok: false, reason: 'no-tailnet-address' }) });
    await hub.autoEnable();
    expect(timers).toHaveLength(1);
    await hub.stop();
    expect(timers).toHaveLength(0);
  });
});

describe('control hub pairing', () => {
  it('refuses to pair unless enabled, without asking the user', async () => {
    const { hub, confirmPair } = setup();
    expect(await hub.createPairing()).toEqual({ ok: false, reason: 'not-enabled' });
    expect(await hub.port.pair('ABCD-EFGH', PEER)).toEqual({ status: 401 });
    expect(confirmPair).not.toHaveBeenCalled();
  });

  it('builds the uri from the listener address and shows the code only in the result', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect(made.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(made.uri).toBe(`aethermobile://pair?host=100.84.175.105&port=47821&code=${made.code}`);
    expect(made.qrSvg).toContain('<svg>');
    expect(JSON.stringify(hub.status())).not.toContain(made.code);
    expect(hub.status().pairingActive).toBe(true);
  });

  it('a successful pair returns a 43-char token once and stores only a hash', async () => {
    const { hub, store, listener } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    expect(r.status === 200 && r.token).toHaveLength(43);
    const token = (r as { token: string }).token;
    expect(store.saved.length).toBeGreaterThan(0);
    const last = store.saved.at(-1)!;
    expect(last).toHaveLength(1);
    expect(Object.keys(last[0]).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'hash', 'lastSeenMs', 'peer']);
    expect(last[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(store.saved)).not.toContain(token);
    expect(JSON.stringify(hub.status())).not.toContain(token);
    expect(hub.port.authenticate(`Bearer ${token}`, PEER)).not.toBeNull();
    expect(listener.recheckControl).toHaveBeenCalled();
  });

  it('a declined pair is 403 and issues nothing', async () => {
    const { hub, store } = setup({ confirm: async () => false });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect(await hub.port.pair(made.code, PEER)).toEqual({ status: 403 });
    expect(hub.status().devices).toHaveLength(0);
    expect(store.saved.flat()).toHaveLength(0);
  });

  it('an unanswered confirm times out to 403', async () => {
    const { hub, timers } = setup({ confirm: () => new Promise<boolean>(() => {}) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    const t = timers.find(x => x.ms === 60000);
    expect(t).toBeDefined();
    timers.splice(timers.indexOf(t!), 1);
    t!.fn();
    expect(await pending).toEqual({ status: 403 });
  });

  it('a confirm that throws is a decline', async () => {
    const { hub } = setup({ confirm: async () => { throw new Error('dialog'); } });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect(await hub.port.pair(made.code, PEER)).toEqual({ status: 403 });
  });

  it('five wrong codes burn the pairing: the sixth attempt is 429', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    await hub.createPairing();
    for (let i = 0; i < 5; i++) expect(await hub.port.pair('ZZZZ-ZZZZ', PEER)).toEqual({ status: 401 });
    expect(await hub.port.pair('ZZZZ-ZZZZ', PEER)).toEqual({ status: 429 });
  });

  it('a second pair asks the confirm with replacesExisting and then supersedes the first device', async () => {
    const { hub, confirmPair, listener } = setup();
    await hub.setEnabled(true);
    const first = await pairOne(hub);
    expect(confirmPair).toHaveBeenLastCalledWith(PEER, false);
    const oldBearer = `Bearer ${(first as { token: string }).token}`;
    const seenAtRecheck: Array<unknown> = [];
    listener.recheckControl.mockImplementation(() => { seenAtRecheck.push(hub.port.authenticate(oldBearer, PEER)); });
    const second = await pairOne(hub);
    expect(seenAtRecheck).toEqual([null]); // the store already dropped the old device when recheck ran
    expect(confirmPair).toHaveBeenLastCalledWith(PEER, true);
    expect(hub.status().devices).toHaveLength(1);
    const a = (first as { token: string }).token;
    const b = (second as { token: string }).token;
    expect(hub.port.authenticate(`Bearer ${a}`, PEER)).toBeNull();
    expect(hub.port.authenticate(`Bearer ${b}`, PEER)).not.toBeNull();
    expect(listener.recheckControl).toHaveBeenCalledTimes(2);
  });

  it('a declined replacement keeps the paired phone', async () => {
    let answer = true;
    const { hub } = setup({ confirm: async () => answer });
    await hub.setEnabled(true);
    const first = await pairOne(hub);
    answer = false;
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect(await hub.port.pair(made.code, PEER)).toEqual({ status: 403 });
    expect(hub.port.authenticate(`Bearer ${(first as { token: string }).token}`, PEER)).not.toBeNull();
  });

  it('a confirm answered after a user disable is 403 and mints nothing', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, store } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    await hub.setEnabled(false);
    answer(true);
    expect(await pending).toEqual({ status: 403 });
    expect(hub.status().devices).toHaveLength(0);
    expect(store.saved.flat()).toHaveLength(0);
  });

  it('a confirm answered after stop (quit) is 403 and mints nothing', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    await hub.stop();
    answer(true);
    expect(await pending).toEqual({ status: 403 });
    expect(hub.status().devices).toHaveLength(0);
  });

  it('a confirm answered after a disable AND re-enable is still 403 (the dialog belongs to the old generation)', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, store } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    await hub.setEnabled(false);
    await hub.setEnabled(true);
    expect(hub.status().state).toBe('on');
    answer(true);
    expect(await pending).toEqual({ status: 403 });
    expect(hub.status().devices).toHaveLength(0);
    expect(store.saved.flat()).toHaveLength(0);
  });

  it('a disable that lands between the approval and the mint revokes the new device and answers 403', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, listener } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    answer(true);
    // same tick: the approval is resolved but redeemDevice has not minted yet
    const disabling = hub.setEnabled(false);
    expect(await pending).toEqual({ status: 403 });
    await disabling;
    expect(hub.status().devices).toHaveLength(0);
    expect(listener.recheckControl).toHaveBeenCalled();
  });

  it('a late answer from a timed-out dialog cannot clear confirmPending for a newer dialog', async () => {
    const answers: Array<(ok: boolean) => void> = [];
    const { hub, timers, confirmPair } = setup({ confirm: () => new Promise<boolean>(r => { answers.push(r); }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const first = hub.port.pair(made.code, PEER);
    await tick();
    const t = timers.find(x => x.ms === 60000)!;
    timers.splice(timers.indexOf(t), 1);
    t.fn();
    expect(await first).toEqual({ status: 403 });
    const made2 = await hub.createPairing();
    if (!made2.ok) throw new Error('no pairing');
    const second = hub.port.pair(made2.code, PEER);
    await tick();
    expect(confirmPair).toHaveBeenCalledTimes(2);
    answers[0](true); // the first, timed-out dialog is answered late
    await tick();
    const made3 = await hub.createPairing();
    if (!made3.ok) throw new Error('no pairing');
    const third = hub.port.pair(made3.code, PEER); // the second dialog is still open, so this must not open a third
    await tick();
    expect(confirmPair).toHaveBeenCalledTimes(2);
    expect(await third).toEqual({ status: 409 });
    answers[1](true);
    expect((await second).status).toBe(200);
  });

  it('a confirm that throws synchronously is a decline', async () => {
    const { hub } = setup({ confirm: () => { throw new Error('dialog'); } });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    expect(await hub.port.pair(made.code, PEER)).toEqual({ status: 403 });
    const again = await hub.createPairing();
    if (!again.ok) throw new Error('no pairing');
    expect(await hub.port.pair(again.code, PEER)).toEqual({ status: 403 }); // not stuck behind a pending dialog (409)
    expect(hub.status().devices).toHaveLength(0);
    expect(hub.status().state).toBe('on');
  });

  it('a second pair while a confirm is open is 409 and does not open another dialog', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, confirmPair } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const first = hub.port.pair(made.code, PEER);
    await tick();
    expect(await hub.port.pair(made.code, PEER)).toEqual({ status: 409 });
    expect(confirmPair).toHaveBeenCalledTimes(1);
    answer(true);
    expect((await first).status).toBe(200);
  });

  it('enabling after stop does not re-acquire the listener', async () => {
    const { hub, listener } = setup();
    await hub.stop();
    const s = await hub.setEnabled(true);
    expect(listener.acquire).not.toHaveBeenCalled();
    expect(s.state).toBe('unavailable');
  });

  it('disabling clears the pairing code', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    await hub.createPairing();
    expect(hub.status().pairingActive).toBe(true);
    await hub.setEnabled(false);
    expect(hub.status().pairingActive).toBe(false);
  });
});

describe('control hub sessions and revoke', () => {
  it('a second open for the same ref closes the older session with bye superseded', async () => {
    const { hub, logs } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const a = fakeSocket();
    const b = fakeSocket();
    hub.port.open(a, id);
    expect(hub.status().connected).toBe(1);
    hub.port.open(b, id);
    expect(a.sent.at(-1)).toBe(JSON.stringify({ t: 'bye', reason: 'superseded' }));
    expect(a.closes).toEqual([1000]);
    expect(b.closes).toEqual([]);
    expect(hub.status().connected).toBe(1);
    a.drop(); // the older socket closing must not drop the newer session
    expect(hub.status().connected).toBe(1);
    b.drop();
    expect(hub.status().connected).toBe(0);
    expect(logs.some(l => l === `control: connect ref=${id.ref} peer=${PEER}`)).toBe(true);
    expect(logs.some(l => l === `control: disconnect ref=${id.ref}`)).toBe(true);
  });

  it('gateway-originated log lines carry the control: prefix exactly once', async () => {
    const { hub, logs } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const s = fakeSocket();
    hub.port.open(s, id);
    s.feed(helloFrame);
    s.feed(helloFrame); // a violation line goes through the same wrapper
    expect(logs).toContain(`control: hello accepted ref=${id.ref}`);
    expect(logs).toContain(`control: repeated hello ref=${id.ref}`);
    expect(logs.some(l => l.startsWith('control: control:'))).toBe(false);
  });
  it('each channel violation logs its own fixed line with the ref', async () => {
    const { hub, logs, timers } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const violate = (feed: (s: ReturnType<typeof fakeSocket>) => void): string[] => {
      const before = logs.length;
      const s = fakeSocket();
      hub.port.open(s, id);
      feed(s);
      return logs.slice(before).filter(l => !l.startsWith('control: connect') && !l.startsWith('control: disconnect'));
    };
    expect(violate(s => s.feed('x'.repeat(CONTROL_CTL_MAX_PAYLOAD + 1)))).toEqual([`control: oversize frame ref=${id.ref}`]);
    expect(violate(s => s.feed('not json'))).toEqual([`control: invalid frame ref=${id.ref}`]);
    expect(violate(s => { s.feed(helloFrame); s.feed(helloFrame); })).toEqual([
      `control: hello accepted ref=${id.ref}`,
      `control: repeated hello ref=${id.ref}`,
    ]);
    expect(violate(() => {
      timers.filter(t => t.ms === CONTROL_HELLO_TIMEOUT_MS).at(-1)!.fn();
    })).toEqual([`control: hello deadline expired ref=${id.ref}`]);
  });

  it('revokeAll and revokeOne log a fixed line (ref only) and never a token or full hash', async () => {
    const { hub, logs } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const ref = hub.status().devices[0].ref;
    await hub.revokeOne(ref);
    expect(logs).toContain(`control: revoke one ref=${ref}`);
    await pairOne(hub);
    await hub.revokeAll();
    expect(logs).toContain('control: revoke all');
    const all = logs.join(' ');
    expect(all).not.toContain((r as { token: string }).token);
    expect(all).not.toMatch(/[0-9a-f]{64}/);
  });

  it('a disable between approval and mint logs the after-approval-race revoke', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, logs } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    answer(true);
    const disabling = hub.setEnabled(false);
    expect(await pending).toEqual({ status: 403 });
    await disabling;
    expect(logs).toContain('control: revoke after-approval-race');
  });

  it('disable closes live sessions with bye disabled', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const s = fakeSocket();
    hub.port.open(s, id);
    await hub.setEnabled(false);
    expect(s.sent.at(-1)).toBe(JSON.stringify({ t: 'bye', reason: 'disabled' }));
  });

  it('revoke rechecks the listener, removes the device and a failed save raises the notice until it clears', async () => {
    const { hub, store, listener, timers } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const ref = hub.status().devices[0].ref;
    listener.recheckControl.mockClear();
    store.failSave = true;
    const s = await hub.revokeOne(ref);
    expect(listener.recheckControl).toHaveBeenCalledTimes(1);
    expect(s.devices).toHaveLength(0);
    expect(s.notice).toBe(CONTROL_REVOKE_UNSAVED_NOTICE);
    expect(hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)).toBeNull();
    expect(timers.some(t => t.ms === 1000)).toBe(true); // bounded save retry
    store.failSave = false;
    expect((await hub.retrySave()).notice).toBeNull();
  });

  it('revokeAll rechecks the listener and empties the device list', async () => {
    const { hub, listener } = setup();
    await hub.setEnabled(true);
    await pairOne(hub);
    listener.recheckControl.mockClear();
    const s = await hub.revokeAll();
    expect(s.devices).toHaveLength(0);
    expect(listener.recheckControl).toHaveBeenCalledTimes(1);
  });

  it('status never carries a code, token or hash', async () => {
    const { hub } = setup();
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const r = await hub.port.pair(made.code, PEER);
    const dump = JSON.stringify(hub.status());
    expect(dump).not.toContain((r as { token: string }).token);
    expect(dump).not.toContain(made.code);
    expect(dump).not.toMatch(/[0-9a-f]{64}/);
    for (const d of hub.status().devices) expect(Object.keys(d).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'lastSeenMs', 'peer', 'ref']);
  });

  it('log lines never carry a token, code or full hash', async () => {
    const { hub, logs } = setup();
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const r = await hub.port.pair(made.code, PEER);
    await hub.revokeAll();
    const all = logs.join('\n');
    expect(all).not.toContain((r as { token: string }).token);
    expect(all).not.toContain(made.code);
    expect(all).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('control hub terminals retain balance', () => {
  it('retains when control turns on, not before, and once however often enable is repeated', async () => {
    const { hub, terms } = setup();
    hub.init();
    expect(terms.retains).toBe(0);
    await hub.setEnabled(true);
    await hub.setEnabled(true);
    expect(terms).toEqual({ retains: 1, releases: 0 });
  });

  it('a user disable releases once; a later stop() does not release again', async () => {
    const { hub, terms } = setup();
    await hub.setEnabled(true);
    await hub.setEnabled(false);
    expect(terms).toEqual({ retains: 1, releases: 1 });
    await hub.stop();
    expect(terms).toEqual({ retains: 1, releases: 1 });
  });

  it('stop() at quit releases once, and a repeated stop() does not', async () => {
    const { hub, terms } = setup();
    await hub.setEnabled(true);
    await hub.stop();
    await hub.stop();
    expect(terms).toEqual({ retains: 1, releases: 1 });
  });

  it('never retains when the listener is unavailable (reason, or acquire throwing), and stop() releases nothing', async () => {
    const a = setup({ acquire: async () => ({ ok: false, reason: 'port-in-use' }) });
    await a.hub.setEnabled(true);
    await a.hub.stop();
    expect(a.terms).toEqual({ retains: 0, releases: 0 });
    const b = setup({ acquire: async () => { throw new Error('boom'); } });
    await b.hub.setEnabled(true);
    await b.hub.setEnabled(false);
    expect(b.terms).toEqual({ retains: 0, releases: 0 });
  });

  it('a failed launch attempt followed by a successful retry holds exactly one retain', async () => {
    let n = 0;
    const { hub, terms } = setup({ flag: true, acquire: async () => (n++ === 0 ? { ok: false, reason: 'no-tailnet-address' } : { ok: true, address: ADDR }) });
    await hub.autoEnable();
    expect(terms.retains).toBe(0);
    await hub.setEnabled(true);
    expect(terms).toEqual({ retains: 1, releases: 0 });
    await hub.stop();
    expect(terms).toEqual({ retains: 1, releases: 1 });
  });

  it('a disable while a pairing confirm is open releases once, and the late answer neither re-retains nor releases', async () => {
    let answer: (ok: boolean) => void = () => {};
    const { hub, terms } = setup({ confirm: () => new Promise<boolean>(r => { answer = r; }) });
    await hub.setEnabled(true);
    const made = await hub.createPairing();
    if (!made.ok) throw new Error('no pairing');
    const pending = hub.port.pair(made.code, PEER);
    await tick();
    await hub.setEnabled(false);
    expect(terms).toEqual({ retains: 1, releases: 1 });
    answer(true);
    expect(await pending).toEqual({ status: 403 });
    await hub.stop();
    expect(terms).toEqual({ retains: 1, releases: 1 });
  });

  it('a throwing release does not break the disable, and the next enable retains afresh and balances again', async () => {
    const terminals = fakeTerminals({ throwOnRelease: true });
    const { hub, terms } = setup({ terminals });
    await hub.setEnabled(true);
    await expect(hub.setEnabled(false)).resolves.toMatchObject({ state: 'off' });
    expect(terms).toEqual({ retains: 1, releases: 1 });
    await hub.setEnabled(true);
    await hub.stop();
    expect(terms).toEqual({ retains: 2, releases: 2 });
  });

  it('a session whose socket send and close both throw cannot keep the retain or the listener: disable then stop() balance', async () => {
    const { hub, terms, listener } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const bad = fakeSocket();
    bad.send = () => { throw new Error('send gone'); };
    bad.close = () => { throw new Error('close gone'); };
    hub.port.open(bad, id);
    await expect(hub.setEnabled(false)).resolves.toMatchObject({ state: 'off' });
    expect(terms).toEqual({ retains: 1, releases: 1 });
    expect(listener.release).toHaveBeenCalledTimes(1);
    await hub.stop();
    expect(terms).toEqual({ retains: 1, releases: 1 });
    expect(hub.status().state).toBe('off');
  });

  it('when the first of two sessions fails to close, the second is still closed with bye disabled', async () => {
    const { hub, terms } = setup();
    await hub.setEnabled(true);
    const r = await pairOne(hub);
    const id = hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const first = fakeSocket();
    first.send = () => { throw new Error('send gone'); };
    first.close = () => { throw new Error('close gone'); };
    const second = fakeSocket();
    hub.port.open(first, id);
    hub.port.open(second, { ...id, ref: 'ffffffffffff' });
    await hub.setEnabled(false);
    expect(second.sent.at(-1)).toBe(JSON.stringify({ t: 'bye', reason: 'disabled' }));
    expect(second.closes).toEqual([1000]);
    expect(terms).toEqual({ retains: 1, releases: 1 });
  });

  it('a throwing retain leaves control on, logs a fixed line and attempts no release', async () => {
    const { hub, terms, logs } = setup({ terminals: fakeTerminals({ throwOnRetain: true }) });
    await expect(hub.setEnabled(true)).resolves.toMatchObject({ state: 'on' });
    expect(logs).toContain('control: terminals unavailable');
    await hub.stop();
    expect(terms).toEqual({ retains: 0, releases: 0 });
  });
});

describe('control hub input wiring', () => {
  const inFrame = (c: number, d: string): string => JSON.stringify({ t: 'in', s: 'claude', c, d });
  async function connect(h: ReturnType<typeof setup>) {
    await h.hub.setEnabled(true);
    const r = await pairOne(h.hub);
    const id = h.hub.port.authenticate(`Bearer ${(r as { token: string }).token}`, PEER)!;
    const s = fakeSocket();
    h.hub.port.open(s, id);
    s.feed(helloFrame);
    s.feed(JSON.stringify({ t: 'attach', s: 'claude' }));
    return { s, id };
  }

  it('passes the input port through: an in frame from an attached socket reaches the fake write port once', async () => {
    const h = setup();
    const { s } = await connect(h);
    s.feed(inFrame(1, 'ls\r'));
    expect(h.writes).toEqual(['claude|ls\r']);
  });

  it('writes the data to no log line, and router lines carry ref=', async () => {
    const h = setup();
    const { s, id } = await connect(h);
    s.feed(inFrame(1, 'HUNTER2-SENTINEL'));
    expect(h.logs.join(' ')).not.toContain('HUNTER2');
    expect(h.logs).toContain(`control: first input slot=claude bytes=16 ref=${id.ref}`);
  });

  it('after disable no write is possible: the socket is closed and a later in frame writes nothing', async () => {
    const h = setup();
    const { s } = await connect(h);
    await h.hub.setEnabled(false);
    s.feed(inFrame(1, 'x'));
    expect(h.writes).toEqual([]);
  });

  it('revokeAll closes the gateway session itself (bye revoked) so an in frame in the ws close window writes nothing', async () => {
    const h = setup();
    const { s } = await connect(h);
    s.feed(inFrame(1, 'a'));
    await h.hub.revokeAll();
    expect(s.sent.at(-1)).toBe(JSON.stringify({ t: 'bye', reason: 'revoked' }));
    s.feed(inFrame(2, 'b'));
    expect(h.writes).toEqual(['claude|a']);
  });
});

describe('device auth peer binding', () => {
  it('ships with peer binding enforced', () => {
    expect(PEER_BINDING_ENFORCED).toBe(true);
  });

  it('redeemDevice with peerBinding off still refuses a missing or non-IPv4 peer', async () => {
    const auth = createDeviceAuth({ store: fakeStore(), peerBinding: false });
    const { code } = auth.createPairing();
    const approve = vi.fn(async () => true);
    expect(await auth.redeemDevice(code, undefined, approve)).toEqual({ ok: false, status: 401 });
    expect(await auth.redeemDevice(code, '::1', approve)).toEqual({ ok: false, status: 401 });
    expect(approve).not.toHaveBeenCalled();
  });
});
