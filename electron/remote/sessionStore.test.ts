// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../atomicWrite', async (orig) => {
  const real = await orig<typeof import('../atomicWrite')>();
  return { ...real, writeFileAtomically: vi.fn(real.writeFileAtomically) };
});

import { writeFileAtomically } from '../atomicWrite';
import { createSessionStore } from './sessionStore';

const H = (c: string) => c.repeat(64);
const mk = (c: string, n = 1000) => ({
  hash: H(c),
  createdAtMs: n,
  expiresAtMs: n + 5000,
  lastSeenMs: n + 10,
});

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aether-sessstore-'));
  file = join(dir, 'remote-sessions.json');
  vi.mocked(writeFileAtomically).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sessionStore', () => {
  it('round-trips through save and load via writeFileAtomically', async () => {
    const s = createSessionStore(file);
    await s.save([mk('a'), mk('b', 2000)]);
    expect(writeFileAtomically).toHaveBeenCalledTimes(1);
    expect(s.load()).toEqual([mk('a'), mk('b', 2000)]);
  });

  it('loads empty for missing, garbage, truncated, empty, wrong-version and oversize files', () => {
    const s = createSessionStore(file);
    expect(s.load()).toEqual([]);
    for (const body of ['not json', '{"v":1,"sess', '', '{"v":2,"sessions":[]}', 'null']) {
      writeFileSync(file, body);
      expect(s.load()).toEqual([]);
    }
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [mk('a')], pad: 'x'.repeat(70 * 1024) }));
    expect(s.load()).toEqual([]);
  });

  it('drops invalid entries and keeps valid siblings', () => {
    const bad = [
      { ...mk('c'), hash: 'ABC' },
      { ...mk('c'), hash: H('g') },
      { ...mk('c'), createdAtMs: -1 },
      { ...mk('c'), lastSeenMs: 1.5 },
      { ...mk('c'), expiresAtMs: 1000 },
      null,
      'x',
    ];
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [bad[0], mk('a'), ...bad.slice(1), mk('b')] }));
    expect(createSessionStore(file).load()).toEqual([mk('a'), mk('b')]);
  });

  it('never carries extra fields from disk or from a caller', async () => {
    const extra = { ...mk('a'), token: 'SECRET', ua: 'x', text: 'hello' };
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [extra] }));
    const s = createSessionStore(file);
    const loaded = s.load();
    expect(Object.keys(loaded[0]).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'hash', 'lastSeenMs']);
    await s.save([extra, loaded[0]] as never);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('"token"');
    expect(raw).not.toContain('SECRET');
    for (const e of JSON.parse(raw).sessions) {
      expect(Object.keys(e).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'hash', 'lastSeenMs']);
    }
  });

  it('save validates values: bad entries are dropped and nothing leaks', async () => {
    const s = createSessionStore(file);
    const evil = [
      { ...mk('a'), hash: 'SECRET token text here', createdAtMs: { token: 'LEAK' } },
      { ...mk('c'), lastSeenMs: { toJSON: () => 'LEAKED' } },
      { ...mk('d'), createdAtMs: NaN },
      { ...mk('e'), expiresAtMs: Infinity },
      mk('b'),
    ];
    await s.save(evil as never);
    const raw = readFileSync(file, 'utf8');
    expect(JSON.parse(raw).sessions).toEqual([mk('b')]);
    expect(raw).not.toMatch(/LEAK|SECRET/);
    await expect(s.save(null as never)).rejects.toThrow();
  });

  it('save snapshots each field once: stateful getters and Proxies cannot leak', async () => {
    const s = createSessionStore(file);
    let h = 0;
    let c = 0;
    const getterHash = { ...mk('a'), get hash() { return ++h <= 2 ? H('a') : 'SECRET'; } };
    const getterStamp = { ...mk('c'), get createdAtMs() { return ++c <= 2 ? 1000 : { toJSON: () => 'LEAK' }; } };
    let reads = 0;
    const proxy = new Proxy(mk('d'), {
      get(t2, k) {
        if (k === 'hash') return ++reads <= 2 ? H('d') : 'SECRET';
        return (t2 as Record<string | symbol, unknown>)[k];
      },
    });
    await s.save([getterHash, getterStamp, proxy, mk('b')] as never);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toMatch(/SECRET|LEAK/);
    for (const e of JSON.parse(raw).sessions) {
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(e).sort()).toEqual(['createdAtMs', 'expiresAtMs', 'hash', 'lastSeenMs']);
    }
  });

  it('save rejects a non-array without touching list.map or the disk', async () => {
    const s = createSessionStore(file);
    const fake = { length: 1, 0: mk('a'), map: () => [{ evil: 1 }] };
    await expect(s.save(fake as never)).rejects.toThrow(TypeError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('save writes a snapshot: later mutation of the caller array is ignored', async () => {
    const s = createSessionStore(file);
    const list = [mk('a')];
    const p = s.save(list);
    list[0].hash = 'SECRET';
    list.push(mk('b'));
    await p;
    expect(s.load()).toEqual([mk('a')]);
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET');
  });

  it('save caps at 20 entries', async () => {
    const s = createSessionStore(file);
    await s.save(Array.from({ length: 25 }, (_, i) => ({ ...mk('a'), hash: String(i).padStart(64, '0') })));
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(20);
  });

  it('keeps at most 20 entries', () => {
    const list = Array.from({ length: 25 }, (_, i) => ({ ...mk('a'), hash: String(i).padStart(64, '0') }));
    writeFileSync(file, JSON.stringify({ v: 1, sessions: list }));
    expect(createSessionStore(file).load()).toHaveLength(20);
  });

  it('save([]) writes a valid empty file', async () => {
    const s = createSessionStore(file);
    await s.save([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, sessions: [] });
    expect(s.load()).toEqual([]);
  });

  it('overlapping saves never interleave and the last call wins; no temp files remain', async () => {
    const s = createSessionStore(file);
    const p1 = s.save([mk('a')]);
    const p2 = s.save([mk('b', 2000)]);
    await Promise.all([p1, p2]);
    expect(s.load()).toEqual([mk('b', 2000)]);
    expect(readdirSync(dir)).toEqual(['remote-sessions.json']);
  });

  it('propagates write errors and still serves later saves', async () => {
    const s = createSessionStore(file);
    vi.mocked(writeFileAtomically).mockRejectedValueOnce(new Error('disk'));
    await expect(s.save([mk('a')])).rejects.toThrow('disk');
    await s.save([mk('b')]);
    expect(s.load()).toEqual([mk('b')]);
  });

  it('source holds no chat/cookie/token identifiers outside comments', () => {
    const src = readFileSync(join(__dirname, 'sessionStore.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/ChatEvent|text:|cookie|token/i);
  });
});

describe('device-mode store (peer)', () => {
  const withPeer = (c: string, peer: string, n = 1000) => ({ ...mk(c, n), peer });

  it('round-trips peer and writes exactly the five fields', async () => {
    const s = createSessionStore(file, { peer: true });
    await s.save([withPeer('a', '100.94.15.125')]);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc).toEqual({ v: 1, sessions: [{ hash: H('a'), createdAtMs: 1000, expiresAtMs: 6000, lastSeenMs: 1010, peer: '100.94.15.125' }] });
    expect(s.load()).toEqual([withPeer('a', '100.94.15.125')]);
  });

  it('drops entries with a missing or bad peer, on save and on load', async () => {
    const s = createSessionStore(file, { peer: true });
    await s.save([mk('a'), withPeer('b', 'not-an-ip'), withPeer('c', '1.2.3.4')]);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(1);
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [mk('d'), withPeer('e', '1.2.3.4;x'), withPeer('f', '9.9.9.9')] }));
    expect(s.load().map((x) => x.hash)).toEqual([H('f')]);
  });

  it('a viewer-mode store drops entries that carry a peer, on save and on load', async () => {
    const s = createSessionStore(file);
    await s.save([withPeer('a', '100.94.15.125'), mk('b')]);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toEqual([mk('b')]);
    writeFileSync(file, JSON.stringify({ v: 1, sessions: [withPeer('c', '1.2.3.4'), mk('d')] }));
    expect(s.load().map((x) => x.hash)).toEqual([H('d')]);
  });
});
