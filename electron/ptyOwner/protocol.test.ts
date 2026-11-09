import { describe, expect, it } from 'vitest';
import {
  ENV_MAX_BYTES, FRAME_MAX_BYTES, META_MAX_BYTES, PROTO,
  createFrameReader, decodeDiscovery, discoveryFileName, encodeDiscovery, encodeFrame,
  newNonce, newSecret, parseClientFrame, parseHelperFrame, signProof, verifyProof,
  type FrameError,
} from './protocol';

const HOME = 'C:\\Users\\Someone';
const spec = (over: Record<string, unknown> = {}) => ({
  file: 'powershell.exe', args: [], cwd: HOME, env: { PATH: 'C:\\x', A: 'b' }, cols: 100, rows: 30, writes: ['claude\r'], ...over,
});
const spawn = (specOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ t: 'spawn', slot: 'claude', spec: spec(specOver), meta: { kind: 'claude', sessionId: 'abc' }, ...over });

function read(chunks: Array<Uint8Array | string>) {
  const frames: unknown[] = []; const errors: FrameError[] = [];
  const r = createFrameReader(f => frames.push(f), e => errors.push(e));
  for (const c of chunks) r.push(c);
  return { frames, errors };
}

describe('frame codec', () => {
  it('reassembles frames split across chunks, including a split 4-byte UTF-8 char', () => {
    const bytes = Buffer.from(encodeFrame({ t: 'write', slot: 'claude', d: 'a\u{1F600}b' }) + encodeFrame({ t: 'ping' }));
    const cut = bytes.indexOf(0xF0) + 2; // mid-emoji
    const { frames, errors } = read([bytes.subarray(0, 5), bytes.subarray(5, cut), bytes.subarray(cut)]);
    expect(errors).toEqual([]);
    expect(frames).toEqual([{ t: 'write', slot: 'claude', d: 'a\u{1F600}b' }, { t: 'ping' }]);
  });

  it('rejects an oversize line, both unterminated and terminated, and stays dead', () => {
    const big = Buffer.alloc(FRAME_MAX_BYTES + 1, 0x61);
    expect(read([big]).errors).toEqual(['oversize']);
    const r = read([Buffer.concat([big, Buffer.from('\n')]), Buffer.from('{"t":"ping"}\n')]);
    expect(r.errors).toEqual(['oversize']);
    expect(r.frames).toEqual([]);
  });

  it('rejects invalid UTF-8, bad JSON, empty lines and non-object frames', () => {
    expect(read([Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]).errors).toEqual(['utf8']);
    expect(read(['{nope\n']).errors).toEqual(['json']);
    expect(read(['\n']).errors).toEqual(['json']);
    expect(read(['[1]\n']).errors).toEqual(['shape']);
    expect(read(['"x"\n']).errors).toEqual(['shape']);
  });

  it('encodeFrame throws above the cap and accepts one just under it', () => {
    expect(() => encodeFrame({ t: 'write', d: 'x'.repeat(FRAME_MAX_BYTES) })).toThrow();
    expect(encodeFrame({ t: 'write', d: 'x'.repeat(FRAME_MAX_BYTES - 100) }).endsWith('\n')).toBe(true);
  });
});

describe('frame validators', () => {
  const nonce = newNonce(); const proof = signProof(newSecret(), 'client', nonce);
  const slotInfo = { slot: 'codex', state: 'running', cols: 80, rows: 24, meta: { k: 1 }, startedAt: 5 };
  const clientFrames: unknown[] = [
    { t: 'hello', proto: PROTO, nonceC: nonce }, { t: 'auth', proofC: proof }, { t: 'claim' }, { t: 'list' },
    spawn(), { t: 'attach', slot: 'terminal2' }, { t: 'write', slot: 'codex', d: 'x' },
    { t: 'resize', slot: 'claude', cols: 90, rows: 20 }, { t: 'kill', slot: 'claude' }, { t: 'forget', slot: 'claude' },
    { t: 'ping' }, { t: 'release' }, { t: 'shutdown' },
  ];
  const helperFrames: unknown[] = [
    { t: 'challenge', nonceS: nonce, proofS: proof }, { t: 'ready', slots: [slotInfo] }, { t: 'slots', slots: [] },
    { t: 'attached', slot: 'claude', state: 'exited', cols: 80, rows: 24, meta: {}, startedAt: 1, ring: [{ seq: 1, d: 'a' }], seq: 1 },
    { t: 'data', slot: 'claude', seq: 2, d: 'x' }, { t: 'exit', slot: 'claude' }, { t: 'pong' }, { t: 'busy' },
    { t: 'displaced' }, { t: 'error', code: 'bad-spec' },
  ];

  it('every client verb round-trips through the codec and validator', () => {
    for (const f of clientFrames) {
      const { frames } = read([encodeFrame(f)]);
      expect(parseClientFrame(frames[0], HOME)).toEqual(f);
    }
  });
  it('every helper verb round-trips through the codec and validator', () => {
    for (const f of helperFrames) {
      const { frames } = read([encodeFrame(f)]);
      expect(parseHelperFrame(frames[0])).toEqual(f);
    }
  });
  it('rejects extra keys, unknown verbs, unknown slots and bad numbers', () => {
    for (const f of clientFrames) expect(parseClientFrame({ ...(f as object), extra: 1 }, HOME)).toBeNull();
    for (const f of helperFrames) expect(parseHelperFrame({ ...(f as object), extra: 1 }, )).toBeNull();
    expect(parseClientFrame({ t: 'bogus' }, HOME)).toBeNull();
    expect(parseClientFrame({ t: 'attach', slot: 'nope' }, HOME)).toBeNull();
    expect(parseClientFrame({ t: 'resize', slot: 'claude', cols: 0, rows: 20 }, HOME)).toBeNull();
    expect(parseClientFrame({ t: 'resize', slot: 'claude', cols: 1.5, rows: 20 }, HOME)).toBeNull();
    expect(parseClientFrame({ t: 'resize', slot: 'claude', cols: Infinity, rows: 20 }, HOME)).toBeNull();
    expect(parseClientFrame({ t: 'hello', proto: 1, nonceC: 'zz' }, HOME)).toBeNull();
    expect(parseHelperFrame({ t: 'data', slot: 'claude', seq: -1, d: 'x' })).toBeNull();
    expect(parseHelperFrame({ t: 'error', code: 'Has Spaces' })).toBeNull();
  });

  it('accepts the exact spawn shape main builds and copies the spec', () => {
    const out = parseClientFrame(spawn(), HOME);
    expect(out).toMatchObject({ t: 'spawn', slot: 'claude', spec: { file: 'powershell.exe', cwd: HOME, cols: 100, rows: 30 } });
  });
  it('rejects every spec that is not the exact shape', () => {
    const bad: Array<Record<string, unknown>> = [
      { file: 'cmd.exe' }, { file: 'C:\\Windows\\System32\\powershell.exe' }, { args: ['-NoProfile'] },
      { cwd: 'C:\\Windows' }, { env: { A: 1 } }, { env: [] }, { env: { 'A=B': 'x' } }, { env: { A: 'a\0b' } },
      { env: { BIG: 'x'.repeat(ENV_MAX_BYTES) } }, { cols: 0 }, { rows: 2.5 }, { writes: [1] }, { writes: 'x' },
      { extra: true },
    ];
    for (const b of bad) expect(parseClientFrame(spawn(b), HOME), JSON.stringify(b).slice(0, 40)).toBeNull();
    expect(parseClientFrame(spawn({ cwd: undefined }), HOME)).toBeNull();
    expect(parseClientFrame(spawn(), '')).toBeNull();
  });
  it('rejects meta over the cap, non-object meta and an unknown slot on spawn', () => {
    expect(parseClientFrame(spawn({}, { meta: { x: 'y'.repeat(META_MAX_BYTES) } }), HOME)).toBeNull();
    expect(parseClientFrame(spawn({}, { meta: 'str' }), HOME)).toBeNull();
    expect(parseClientFrame(spawn({}, { slot: 'bogus' }), HOME)).toBeNull();
  });
});

describe('mutual HMAC proofs', () => {
  const secret = newSecret(); const nonce = newNonce();
  it('accepts the right role and nonce', () => {
    expect(verifyProof(secret, 'server', nonce, signProof(secret, 'server', nonce))).toBe(true);
    expect(verifyProof(secret, 'client', nonce, signProof(secret, 'client', nonce))).toBe(true);
  });
  it('rejects swapped roles, wrong nonce, wrong secret and malformed or truncated hex', () => {
    const server = signProof(secret, 'server', nonce);
    expect(verifyProof(secret, 'client', nonce, server)).toBe(false);
    expect(verifyProof(secret, 'server', newNonce(), server)).toBe(false);
    expect(verifyProof(newSecret(), 'server', nonce, server)).toBe(false);
    expect(verifyProof(secret, 'server', nonce, server.slice(0, 62))).toBe(false);
    expect(verifyProof(secret, 'server', nonce, server.slice(0, 32))).toBe(false);
    expect(verifyProof(secret, 'server', nonce, `${server.slice(0, 63)}g`)).toBe(false);
    expect(verifyProof(secret, 'server', nonce, server.toUpperCase())).toBe(false);
    expect(verifyProof(secret, 'server', nonce, undefined)).toBe(false);
    expect(verifyProof('abcd', 'server', nonce, server)).toBe(false);
    expect(verifyProof(secret, 'other' as never, nonce, server)).toBe(false);
  });
  it('nonces and secrets are fresh hex of the expected length', () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/); expect(newSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe('discovery file', () => {
  const d = { v: 1 as const, pipe: '\\\\.\\pipe\\aether-pty-abc', pid: 1234, startedAt: 1700000000000, secret: newSecret() };
  it('round-trips and rejects bad shapes', () => {
    expect(decodeDiscovery(encodeDiscovery(d))).toEqual(d);
    expect(decodeDiscovery('nope')).toBeNull();
    expect(decodeDiscovery(JSON.stringify({ ...d, extra: 1 }))).toBeNull();
    expect(decodeDiscovery(JSON.stringify({ ...d, v: 2 }))).toBeNull();
    expect(decodeDiscovery(JSON.stringify({ ...d, pid: 0 }))).toBeNull();
    expect(decodeDiscovery(JSON.stringify({ ...d, secret: 'abc' }))).toBeNull();
    expect(decodeDiscovery(JSON.stringify({ ...d, pipe: 'C:\\evil' }))).toBeNull();
  });
  it('file name differs per userData and per proto', () => {
    const a = discoveryFileName('C:\\u\\a', 1);
    expect(a).toMatch(/^pty-owner-[0-9a-f]{8}-p1\.json$/);
    expect(discoveryFileName('C:\\u\\b', 1)).not.toBe(a);
    expect(discoveryFileName('C:\\u\\a', 2)).not.toBe(a);
    expect(discoveryFileName('C:\\u\\a', 1)).toBe(a);
  });
});
