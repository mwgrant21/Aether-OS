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
    await expect(auth.flush()).resolves.toBeUndefined();
    expect(auth.isAuthenticated(r.ok ? r.cookie.split(';')[0] : '')).toBe(true);
  });

  it('a synchronously throwing save is swallowed too', async () => {
    const store = fakeStore();
    store.save = () => { throw new Error('sync boom'); };
    const { auth } = setup({ store });
    expect(() => pairOne(auth)).not.toThrow();
    await expect(auth.flush()).resolves.toBeUndefined();
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
