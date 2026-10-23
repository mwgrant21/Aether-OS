// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRemoteAuth, isAllowedHost, isAllowedOrigin } from './remoteAuth';
import type { SessionStorePort, StoredSession } from './types';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function fakeStore(initial: StoredSession[] = []) {
  const saves: StoredSession[][] = [];
  const store: SessionStorePort & { saves: StoredSession[][]; current: StoredSession[] } = {
    saves,
    current: initial,
    load: () => store.current,
    save: async (list) => {
      saves.push(list);
      store.current = list;
    },
  };
  return store;
}

function setup(over: Parameters<typeof createRemoteAuth>[0] = {}) {
  let t = 1_000_000;
  let n = 0;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const store = (over as { store?: ReturnType<typeof fakeStore> }).store ?? fakeStore();
  const auth = createRemoteAuth({
    now: clock.now,
    randomBytes: (len) => Buffer.alloc(len, ++n),
    store,
    ...over,
  });
  return { auth, clock, store };
}

function pairOne(auth: ReturnType<typeof createRemoteAuth>) {
  const { code } = auth.createPairing();
  const r = auth.redeem(code);
  if (!r.ok) throw new Error('pair failed');
  return r.cookie.split(';')[0];
}

describe('pairing code', () => {
  it('is XXXX-XXXX from the restricted alphabet', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it('is single-use', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    expect(auth.redeem(code).ok).toBe(true);
    expect(auth.redeem(code)).toEqual({ ok: false, status: 401 });
  });

  it('expires at the 60 minute boundary', () => {
    const { auth, clock } = setup();
    const { code } = auth.createPairing();
    clock.advance(60 * MIN - 1);
    expect(auth.counts().pairingActive).toBe(true);
    clock.advance(1);
    expect(auth.counts().pairingActive).toBe(false);
    expect(auth.redeem(code)).toEqual({ ok: false, status: 401 });
  });

  it('clearPairing drops the code and resets the burned state', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    auth.clearPairing();
    expect(auth.counts().pairingActive).toBe(false);
    expect(auth.redeem(code)).toEqual({ ok: false, status: 401 });
    for (let i = 0; i < 5; i++) auth.redeem('AAAA-AAAA');
    auth.clearPairing();
    const next = auth.createPairing();
    expect(auth.redeem(next.code).ok).toBe(true);
  });

  it('is replaced by a new createPairing', () => {
    const { auth } = setup();
    let i = 0;
    const a = setup({ randomInt: () => (i++ < 8 ? 0 : 1) }).auth;
    const first = a.createPairing().code;
    const second = a.createPairing().code;
    expect(first).not.toBe(second);
    expect(a.redeem(first)).toEqual({ ok: false, status: 401 });
    expect(a.redeem(second).ok).toBe(true);
    expect(auth.counts().pairingActive).toBe(false);
  });

  it('burns after 5 wrong attempts: the 6th, with the correct code, is 429', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    for (let i = 0; i < 5; i++) expect(auth.redeem('WRONG-CODE')).toEqual({ ok: false, status: 401 });
    expect(auth.redeem(code)).toEqual({ ok: false, status: 429 });
    expect(auth.counts().pairingActive).toBe(false);
    const next = auth.createPairing().code;
    expect(auth.redeem(next).ok).toBe(true);
  });

  it('still accepts the correct code after 4 wrong attempts', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    for (let i = 0; i < 4; i++) auth.redeem('NOPE-NOPE');
    expect(auth.redeem(code).ok).toBe(true);
  });

  it('counts nothing when there is no active code', () => {
    const { auth } = setup();
    for (let i = 0; i < 10; i++) expect(auth.redeem('AAAA-AAAA')).toEqual({ ok: false, status: 401 });
    expect(auth.redeem(auth.createPairing().code).ok).toBe(true);
  });

  it('normalises case, spaces, hyphens and en-dash; rejects non-strings', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    const raw = code.replace('-', '');
    expect(auth.redeem(42)).toEqual({ ok: false, status: 401 });
    expect(auth.redeem(undefined)).toEqual({ ok: false, status: 401 });
    expect(auth.redeem(` ${raw.slice(0, 4).toLowerCase()} – ${raw.slice(4).toLowerCase()} `).ok).toBe(true);
  });

  it('compares with timingSafeEqual rather than ===', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./remoteAuth.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/timingSafeEqual\(a, b\)/);
    expect(src).not.toMatch(/normalised\s*===|===\s*active\.normalised|given\s*===/);
  });
});

describe('sessions and cookie', () => {
  it('issues the exact cookie attributes with no Secure flag', () => {
    const { auth } = setup();
    const { code } = auth.createPairing();
    const r = auth.redeem(code);
    expect(r.ok && r.cookie).toMatch(/^aether_remote=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    expect(r.ok && r.cookie).not.toMatch(/Secure/);
  });

  it('authenticates a valid cookie and rejects garbage, zero or duplicate cookies', () => {
    const { auth } = setup();
    const cookie = pairOne(auth);
    expect(auth.isAuthenticated(cookie)).toBe(true);
    expect(auth.isAuthenticated(`x=1; ${cookie}; y=2`)).toBe(true);
    expect(auth.isAuthenticated(`${cookie}; ${cookie}`)).toBe(false);
    expect(auth.isAuthenticated(`${cookie}; aether_remote=other`)).toBe(false);
    expect(auth.isAuthenticated(undefined)).toBe(false);
    expect(auth.isAuthenticated('')).toBe(false);
    expect(auth.isAuthenticated('aether_remote=')).toBe(false);
    expect(auth.isAuthenticated('aether_remote=%%%garbage')).toBe(false);
  });

  it('has an absolute 30 day lifetime that touch does not extend', async () => {
    const { auth, clock, store } = setup();
    const cookie = pairOne(auth);
    clock.advance(30 * DAY - 1);
    expect(auth.isAuthenticated(cookie, { touch: true })).toBe(true);
    clock.advance(1);
    expect(auth.isAuthenticated(cookie)).toBe(false);
    await auth.flush();
    expect(store.current).toEqual([]);
    expect(auth.list()).toEqual([]);
  });

  it('survives a restart: a new auth over the same store accepts the cookie', async () => {
    const a = setup();
    const cookie = pairOne(a.auth);
    await a.auth.flush();
    const b = createRemoteAuth({ now: a.clock.now, store: a.store });
    expect(b.isAuthenticated(cookie)).toBe(true);
    expect(b.list()).toHaveLength(1);
  });

  it('rejects the cookie after restart once the stored entry has expired', async () => {
    const a = setup();
    const cookie = pairOne(a.auth);
    await a.auth.flush();
    a.clock.advance(30 * DAY);
    const b = createRemoteAuth({ now: a.clock.now, store: a.store });
    expect(b.isAuthenticated(cookie)).toBe(false);
    expect(b.list()).toEqual([]);
  });

  it('never validates a revoked session again, including after restart', async () => {
    const a = setup();
    const cookie = pairOne(a.auth);
    a.auth.revokeAll();
    await a.auth.flush();
    expect(a.auth.isAuthenticated(cookie)).toBe(false);
    const b = createRemoteAuth({ now: a.clock.now, store: a.store });
    expect(b.isAuthenticated(cookie)).toBe(false);
  });

  it('persists hashes only: no saved field contains the raw token or the pairing code', async () => {
    const { auth, store } = setup();
    const { code } = auth.createPairing();
    const r = auth.redeem(code);
    if (!r.ok) throw new Error('pair failed');
    const token = r.cookie.split(';')[0].split('=')[1];
    await auth.flush();
    expect(store.saves.length).toBeGreaterThan(0);
    for (const list of store.saves) {
      for (const s of list) {
        expect(Object.keys(s).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'hash', 'lastSeenMs']);
        expect(s.hash).toBe(createHash('sha256').update(token).digest('hex'));
      }
    }
    const blob = JSON.stringify(store.saves);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(code);
    expect(blob).not.toContain(code.replace('-', ''));
  });

  it('never logs the token or code', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const { auth } = setup();
    pairOne(auth);
    auth.redeem('BAD-CODE');
    expect(spies.every(s => s.mock.calls.length === 0)).toBe(true);
    spies.forEach(s => s.mockRestore());
  });

  it('list() is newest first with 12-hex refs and no full hash', () => {
    const { auth, clock } = setup();
    pairOne(auth);
    clock.advance(1000);
    pairOne(auth);
    const l = auth.list();
    expect(l).toHaveLength(2);
    expect(l[0].createdAtMs).toBeGreaterThan(l[1].createdAtMs);
    for (const s of l) {
      expect(s.ref).toMatch(/^[0-9a-f]{12}$/);
      expect(Object.keys(s).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'lastSeenMs', 'ref']);
    }
  });

  it('revokeOne removes only that session and persists; unknown or ambiguous ref is false', async () => {
    const { auth, clock, store } = setup();
    const c1 = pairOne(auth);
    clock.advance(1000);
    const c2 = pairOne(auth);
    await auth.flush();
    const [newest, oldest] = auth.list();
    expect(auth.revokeOne('zzzzzzzzzzzz')).toBe(false);
    expect(auth.revokeOne('')).toBe(false);
    expect(auth.revokeOne(newest.ref)).toBe(true);
    await auth.flush();
    expect(auth.isAuthenticated(c2)).toBe(false);
    expect(auth.isAuthenticated(c1)).toBe(true);
    expect(store.current).toHaveLength(1);
    expect(store.current[0].hash.startsWith(oldest.ref)).toBe(true);
    expect(auth.revokeOne(newest.ref)).toBe(false);
  });

  it('revokeOne is false when two sessions share a ref', async () => {
    const hash = (p: string) => p + 'b'.repeat(64 - p.length);
    const store = fakeStore([
      { hash: hash('aaaaaaaaaaaa'), createdAtMs: 1, expiresAtMs: 9e15, lastSeenMs: 1 },
      { hash: hash('aaaaaaaaaaaa').slice(0, 63) + 'c', createdAtMs: 2, expiresAtMs: 9e15, lastSeenMs: 2 },
    ]);
    const { auth } = setup({ store });
    expect(auth.list()).toHaveLength(2);
    expect(auth.revokeOne('aaaaaaaaaaaa')).toBe(false);
    expect(auth.list()).toHaveLength(2);
  });

  it('revokeAll clears and persists', async () => {
    const { auth, store } = setup();
    pairOne(auth);
    await auth.flush();
    auth.revokeAll();
    await auth.flush();
    expect(store.current).toEqual([]);
    expect(auth.counts().sessions).toBe(0);
  });

  it('evicts the oldest on the 6th session and persists', async () => {
    const { auth, clock, store } = setup();
    const cookies: string[] = [];
    for (let i = 0; i < 6; i++) {
      cookies.push(pairOne(auth));
      clock.advance(1000);
    }
    await auth.flush();
    expect(auth.counts().sessions).toBe(5);
    expect(auth.isAuthenticated(cookies[0])).toBe(false);
    for (const c of cookies.slice(1)) expect(auth.isAuthenticated(c)).toBe(true);
    expect(store.current).toHaveLength(5);
  });

  it('drops expired and malformed stored entries on load', () => {
    const t = 1_000_000;
    const good = { hash: 'a'.repeat(64), createdAtMs: t - 10, expiresAtMs: t + 1000, lastSeenMs: t - 10 };
    const store = fakeStore([
      good,
      { ...good, hash: 'b'.repeat(64), expiresAtMs: t },
      { ...good, hash: 'short' },
      { ...good, hash: 'C'.repeat(64) },
      { ...good, hash: 'd'.repeat(64), lastSeenMs: Number.NaN },
      null as unknown as StoredSession,
    ]);
    const { auth } = setup({ store });
    expect(auth.counts().sessions).toBe(1);
  });

  it('load applies maxSessions: 20 valid entries load as the newest 5', () => {
    const t = 1_000_000;
    const list = Array.from({ length: 20 }, (_, i) => ({
      hash: i.toString(16).padStart(64, '0'), createdAtMs: t - 1000 + i, expiresAtMs: t + 1000, lastSeenMs: t - 1000 + i,
    }));
    const { auth } = setup({ store: fakeStore(list) });
    const got = auth.list();
    expect(got).toHaveLength(5);
    expect(got.map(g => g.createdAtMs)).toEqual([19, 18, 17, 16, 15].map(i => t - 1000 + i));
  });

  it('load drops entries whose expiresAtMs <= createdAtMs', () => {
    const t = 1_000_000;
    const store = fakeStore([{ hash: 'a'.repeat(64), createdAtMs: t + 500, expiresAtMs: t + 100, lastSeenMs: t }]);
    expect(setup({ store }).auth.list()).toEqual([]);
  });

  it('eviction never removes the session just issued when the clock steps back', () => {
    const { auth, clock } = setup();
    for (let i = 0; i < 5; i++) { pairOne(auth); clock.advance(1000); }
    clock.advance(-100_000);
    const cookie = pairOne(auth);
    expect(auth.counts().sessions).toBe(5);
    expect(auth.isAuthenticated(cookie)).toBe(true);
  });

  it('a throwing load yields an empty auth', () => {
    const store = fakeStore();
    store.load = () => { throw new Error('boom'); };
    const { auth } = setup({ store });
    expect(auth.list()).toEqual([]);
    expect(auth.redeem(auth.createPairing().code).ok).toBe(true);
  });
});

describe('persistence discipline', () => {
  it('a rejecting save does not fail redeem or auth, and onChange still fires', async () => {
    const store = fakeStore();
    store.save = async () => { throw new Error('disk full'); };
    const onChange = vi.fn();
    const { auth } = setup({ store, onChange });
    const { code } = auth.createPairing();
    const r = auth.redeem(code);
    expect(r.ok).toBe(true);
    expect(onChange).toHaveBeenCalled();
    await expect(auth.flush()).resolves.toBe(false);
    expect(auth.isAuthenticated(r.ok ? r.cookie.split(';')[0] : '')).toBe(true);
  });

  it('a synchronously throwing save is swallowed too', async () => {
    const store = fakeStore();
    store.save = () => { throw new Error('sync boom'); };
    const { auth } = setup({ store });
    expect(() => pairOne(auth)).not.toThrow();
    await expect(auth.flush()).resolves.toBe(false);
  });

  it('retries a failed revoke save on the next persist so the disk never keeps the revoked hash', async () => {
    const store = fakeStore();
    const { auth, clock } = setup({ store });
    const c1 = pairOne(auth);
    clock.advance(1000);
    pairOne(auth);
    expect(await auth.flush()).toBe(true);
    const revoked = auth.list()[1];
    const realSave = store.save;
    store.save = async () => { throw new Error('disk full'); };
    expect(auth.revokeOne(revoked.ref)).toBe(true);
    expect(await auth.flush()).toBe(false);
    expect(store.current.some(x => x.hash.startsWith(revoked.ref))).toBe(true);
    store.save = realSave;
    expect(await auth.flush()).toBe(true);
    expect(store.current.some(x => x.hash.startsWith(revoked.ref))).toBe(false);
    expect(auth.isAuthenticated(c1)).toBe(false);
    const b = createRemoteAuth({ now: clock.now, store });
    expect(b.isAuthenticated(c1)).toBe(false);
  });

  it('retries on the next change even without flush', async () => {
    const store = fakeStore();
    const { auth, clock } = setup({ store });
    pairOne(auth);
    await auth.flush();
    const realSave = store.save;
    store.save = async () => { throw new Error('x'); };
    auth.revokeAll();
    await auth.flush();
    store.save = realSave;
    clock.advance(1000);
    pairOne(auth);
    await auth.flush();
    expect(store.current).toHaveLength(1);
  });

  it('throttles lastSeen persistence to 5 minute steps', async () => {
    const { auth, clock, store } = setup();
    const cookie = pairOne(auth);
    await auth.flush();
    clock.advance(10 * MIN);
    const base = store.saves.length;
    auth.isAuthenticated(cookie, { touch: true });
    await auth.flush();
    clock.advance(1 * MIN);
    auth.isAuthenticated(cookie, { touch: true });
    await auth.flush();
    expect(store.saves.length - base).toBe(1);
    clock.advance(6 * MIN);
    auth.isAuthenticated(cookie, { touch: true });
    await auth.flush();
    expect(store.saves.length - base).toBe(2);
    expect(store.current[0].lastSeenMs).toBe(clock.now());
  });

  it('touch without the flag never changes lastSeenMs', async () => {
    const { auth, clock } = setup();
    const cookie = pairOne(auth);
    const before = auth.list()[0].lastSeenMs;
    clock.advance(10 * MIN);
    auth.isAuthenticated(cookie);
    expect(auth.list()[0].lastSeenMs).toBe(before);
  });

  it('coalesces overlapping saves and flush resolves after the last one', async () => {
    const store = fakeStore();
    const pending: Array<() => void> = [];
    const done: StoredSession[][] = [];
    store.save = (list) => new Promise<void>(res => {
      pending.push(() => { done.push(list); res(); });
    });
    const { auth } = setup({ store });
    pairOne(auth);
    pairOne(auth);
    pairOne(auth);
    expect(pending).toHaveLength(1);
    let flushed = false;
    const f = auth.flush().then(() => { flushed = true; });
    pending.shift()!();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(pending).toHaveLength(1);
    expect(flushed).toBe(false);
    pending.shift()!();
    await f;
    expect(flushed).toBe(true);
    expect(done[1]).toHaveLength(3);
  });
});

describe('host and origin predicates', () => {
  const bound = '100.64.0.1:47821';
  it('accepts only the exact bound host:port, case-insensitively', () => {
    expect(isAllowedHost(bound, bound)).toBe(true);
    expect(isAllowedHost(bound.toUpperCase(), bound)).toBe(true);
    for (const h of ['evil.test', '100.64.0.1', '100.64.0.1:47822', '100.64.0.1:47821.evil.test',
      'evil.test:47821', '127.0.0.1:47821', 'localhost:47821', '', undefined]) {
      expect(isAllowedHost(h, bound)).toBe(false);
    }
  });
  it('accepts only exactly http://<bound> as Origin; missing and null are rejected', () => {
    expect(isAllowedOrigin(`http://${bound}`, bound)).toBe(true);
    for (const o of ['http://evil.test', 'http://100.64.0.1:47821.evil.test', `https://${bound}`,
      `http://${bound}/`, 'http://100.64.0.1:47822', 'null', '', undefined, null]) {
      expect(isAllowedOrigin(o, bound)).toBe(false);
    }
  });
});

// ---- device (bearer) scope ----
import { readFileSync as readFileSyncDev } from 'node:fs';
import { createDeviceAuth, serverProof } from './remoteAuth';
import { CONTROL_MAX_DEVICES } from '../../src/shared/remote/types';

describe('device auth scope', () => {
  const PEER = '100.94.15.125';
  function dev(over: Parameters<typeof createDeviceAuth>[0] = {}) {
    let t = 1_000_000;
    let n = 0;
    const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
    const store = fakeStore();
    const auth = createDeviceAuth({ now: clock.now, randomBytes: (len) => Buffer.alloc(len, ++n), store, ...over });
    return { auth, clock, store };
  }
  async function pairDev(auth: ReturnType<typeof createDeviceAuth>, peer: string | undefined = PEER) {
    const { code } = auth.createPairing();
    const r = await auth.redeemDevice(code, peer, async () => true);
    if (!r.ok) throw new Error('pair failed');
    return r;
  }
  const bearer = (t: string) => `Bearer ${t}`;

  it('cap is one device and a second redeem evicts the first', async () => {
    expect(CONTROL_MAX_DEVICES).toBe(1);
    const { auth } = dev();
    const a = await pairDev(auth);
    const b = await pairDev(auth);
    expect(auth.list()).toHaveLength(1);
    expect(auth.authenticate(bearer(a.token), PEER)).toBeNull();
    expect(auth.authenticate(bearer(b.token), PEER)).not.toBeNull();
  });

  it('scopes never accept each other\'s credentials', async () => {
    const { auth } = dev();
    const viewer = createRemoteAuth({ randomBytes: (len) => Buffer.alloc(len, 9) });
    const { code } = viewer.createPairing();
    const v = viewer.redeem(code);
    if (!v.ok) throw new Error('viewer pair failed');
    const cookieToken = v.cookie.split(';')[0].split('=')[1];
    expect(auth.authenticate(bearer(cookieToken), PEER)).toBeNull();
    const d = await pairDev(auth);
    expect(viewer.isAuthenticated(`aether_remote=${d.token}`)).toBe(false);
    expect(auth.isAuthenticated(`aether_remote=${d.token}`)).toBe(false);
    expect(auth.redeem('AAAA-AAAA')).toEqual({ ok: false, status: 401 });
    const redeemed = await (viewer as unknown as import('./remoteAuth').DeviceAuth).redeemDevice('x', PEER, async () => true);
    expect(redeemed).toEqual({ ok: false, status: 401 });
    expect((viewer as unknown as import('./remoteAuth').DeviceAuth).authenticate(bearer(d.token), PEER)).toBeNull();
    expect(viewer.list()).toHaveLength(1);
    expect(auth.list()).toHaveLength(1);
  });

  it('parses the bearer header strictly', async () => {
    const { auth } = dev();
    const { token } = await pairDev(auth);
    expect(auth.authenticate(undefined, PEER)).toBeNull();
    expect(auth.authenticate(`Basic ${token}`, PEER)).toBeNull();
    expect(auth.authenticate(`Bearer ${token} ${token}`, PEER)).toBeNull();
    expect(auth.authenticate(`Bearer ${token.slice(1)}`, PEER)).toBeNull();
    expect(auth.authenticate(`Bearer ${token}A`, PEER)).toBeNull();
    expect(auth.authenticate(`bearer ${token}`, PEER)).not.toBeNull();
    const id = auth.authenticate(bearer(token), PEER);
    expect(id?.ref).toHaveLength(12);
  });

  it('slides on touch, expires 30 days after the last touch, and caps at 180 days', async () => {
    const { auth, clock } = dev();
    const { token } = await pairDev(auth);
    clock.advance(20 * DAY);
    expect(auth.authenticate(bearer(token), PEER)).not.toBeNull(); // no touch: no extension
    clock.advance(11 * DAY);
    expect(auth.authenticate(bearer(token), PEER)).toBeNull(); // 31 d after pairing, never touched

    const b = dev();
    const t2 = (await pairDev(b.auth)).token;
    b.clock.advance(20 * DAY);
    expect(b.auth.authenticate(bearer(t2), PEER, { touch: true })).not.toBeNull();
    b.clock.advance(29 * DAY);
    expect(b.auth.authenticate(bearer(t2), PEER)).not.toBeNull();
    b.clock.advance(2 * DAY);
    expect(b.auth.authenticate(bearer(t2), PEER)).toBeNull(); // 31 d after the last touch

    const c = dev();
    const t3 = (await pairDev(c.auth)).token;
    for (let i = 0; i < 17; i++) {
      c.clock.advance(10 * DAY);
      expect(c.auth.authenticate(bearer(t3), PEER, { touch: true })).not.toBeNull();
    }
    expect(c.auth.list()[0].expiresAtMs).toBe(1_000_000 + 170 * DAY + 10 * DAY);
    c.clock.advance(10 * DAY); // day 180: the absolute cap
    expect(c.auth.authenticate(bearer(t3), PEER, { touch: true })).toBeNull();
  });

  it('binds the token to its peer', async () => {
    const { auth } = dev();
    const { token } = await pairDev(auth);
    expect(auth.authenticate(bearer(token), '100.94.15.126')).toBeNull();
    expect(auth.authenticate(bearer(token), undefined)).toBeNull();
    expect(auth.authenticate(bearer(token), `::ffff:${PEER}`)).not.toBeNull();
    expect(auth.list()[0].peer).toBe(PEER);

    const off = dev({ peerBinding: false });
    const t2 = (await pairDev(off.auth)).token;
    expect(off.auth.authenticate(bearer(t2), '10.0.0.9')).not.toBeNull();
  });

  it('redeemDevice honours approve true, false, throw, wrong code and burn', async () => {
    const { auth, store } = dev();
    const { code } = auth.createPairing();
    expect(await auth.redeemDevice(code, PEER, async () => false)).toEqual({ ok: false, status: 403 });
    expect(auth.list()).toHaveLength(0);
    expect(auth.counts().pairingActive).toBe(false); // consumed even when declined

    const second = auth.createPairing();
    expect(await auth.redeemDevice(second.code, PEER, async () => { throw new Error('boom'); })).toEqual({ ok: false, status: 403 });
    expect(auth.list()).toHaveLength(0);

    const third = auth.createPairing();
    expect(await auth.redeemDevice('ZZZZ-ZZZZ', PEER, async () => true)).toEqual({ ok: false, status: 401 });
    const ok = await auth.redeemDevice(third.code, PEER, async () => true);
    expect(ok.ok).toBe(true);
    await auth.flush();
    expect(store.current).toHaveLength(1);
    expect(store.current[0].peer).toBe(PEER);

    auth.createPairing();
    for (let i = 0; i < 5; i++) await auth.redeemDevice('ZZZZ-ZZZZ', PEER, async () => true);
    expect(await auth.redeemDevice('ZZZZ-ZZZZ', PEER, async () => true)).toEqual({ ok: false, status: 429 });
  });

  it('a pending approval cannot be raced with the same code', async () => {
    const { auth } = dev();
    const { code } = auth.createPairing();
    let release!: (v: boolean) => void;
    const first = auth.redeemDevice(code, PEER, () => new Promise<boolean>((r) => { release = r; }));
    expect(await auth.redeemDevice(code, PEER, async () => true)).toEqual({ ok: false, status: 401 });
    release(true);
    expect((await first).ok).toBe(true);
  });

  it('code lives 5 minutes', async () => {
    const { auth, clock } = dev();
    const { code } = auth.createPairing();
    clock.advance(5 * MIN);
    expect(await auth.redeemDevice(code, PEER, async () => true)).toEqual({ ok: false, status: 401 });
    const b = dev();
    const fresh = b.auth.createPairing();
    b.clock.advance(5 * MIN - 1);
    expect((await b.auth.redeemDevice(fresh.code, PEER, async () => true)).ok).toBe(true);
  });

  it('serverProof reproduces the shared vector and identity.proofFor uses the stored hash', async () => {
    const proto = JSON.parse(readFileSyncDev('protocol/mobile-protocol.json', 'utf8'));
    const v = proto.proof.vectors;
    expect(serverProof(v.tokenSha256Hex, v.nonce)).toBe(v.proof);
    const { auth } = dev();
    const { token } = await pairDev(auth);
    const id = auth.authenticate(bearer(token), PEER)!;
    expect(id.proofFor(v.nonce)).toBe(serverProof(createHash('sha256').update(token).digest('hex'), v.nonce));
  });

  it('revoke and revokeAll still work', async () => {
    const { auth } = dev();
    const { token } = await pairDev(auth);
    const ref = auth.list()[0].ref;
    expect(auth.revokeOne(ref)).toBe(true);
    expect(auth.authenticate(bearer(token), PEER)).toBeNull();
    const t2 = (await pairDev(auth)).token;
    auth.revokeAll();
    expect(auth.authenticate(bearer(t2), PEER)).toBeNull();
    expect(auth.list()).toHaveLength(0);
  });

  it('reloads peer from the store and drops it for the viewer profile', async () => {
    const { auth, store } = dev();
    const { token } = await pairDev(auth);
    await auth.flush();
    const again = createDeviceAuth({ store, now: () => 1_000_000 + MIN });
    expect(again.authenticate(bearer(token), PEER)).not.toBeNull();
    expect(again.authenticate(bearer(token), '1.2.3.4')).toBeNull();
    const asViewer = createRemoteAuth({ store, now: () => 1_000_000 + MIN });
    expect(asViewer.list().every((s) => s.peer === undefined)).toBe(true);
  });
});
