// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MESSAGE_TYPES, PROTOCOL_VERSION, encodeBye, encodeOut, encodeSize, encodeSnap, encodeState, encodeWelcome, encodeTadd, encodeTdet, encodeTmeta, encodeTsnap, encodeTupd, parsePhoneMessage, threadEntriesJsonLength } from './protocol';
import type { ThreadEntry, ThreadMeta } from '../../src/shared/remote/threadTypes';
import { CONTROL_BYE_REASONS, CONTROL_MESSAGE_TYPES } from '../../src/shared/remote/types';
import type { TerminalInfo } from '../../src/shared/remote/types';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../protocol/mobile-protocol.json'), 'utf8'));
const w = JSON.parse(spec.frames.welcome);

describe('control protocol matches protocol/mobile-protocol.json', () => {
  it('message types and version', () => {
    expect([...MESSAGE_TYPES.phoneToTitan]).toEqual(spec.messages.phoneToTitan);
    expect([...MESSAGE_TYPES.titanToPhone]).toEqual(spec.messages.titanToPhone);
    expect(PROTOCOL_VERSION).toBe(spec.v);
    expect(MESSAGE_TYPES).toEqual(CONTROL_MESSAGE_TYPES);
  });

  it('bye reasons', () => {
    expect([...CONTROL_BYE_REASONS]).toEqual(spec.messages.byeReasons);
  });

  it('golden hello parses to the same fields', () => {
    expect(parsePhoneMessage(spec.frames.hello)).toEqual(JSON.parse(spec.frames.hello));
  });

  it('golden welcome is reproduced byte for byte by encodeWelcome', () => {
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs })).toBe(spec.frames.welcome);
  });

  it('golden bye is reproduced byte for byte by encodeBye', () => {
    expect(encodeBye('revoked')).toBe(spec.frames.bye);
  });
});

describe('terminal frames match the goldens byte for byte', () => {
  const sessions: TerminalInfo[] = [
    { s: 'claude', label: 'Terminal', state: 'running', cols: 100, rows: 30, q: 12 },
    { s: 'terminal2', label: 'Terminal 2', state: 'not-started', cols: 0, rows: 0, q: 0 },
    { s: 'codex', label: 'Codex', state: 'exited', cols: 80, rows: 24, q: 5 },
  ];
  it('welcomeSessions', () => {
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs, sessions })).toBe(spec.frames.welcomeSessions);
  });
  it('welcome sessions carry exactly the six documented keys', () => {
    const extra = { ...sessions[0], secret: 'x' } as unknown as TerminalInfo;
    const out = JSON.parse(encodeWelcome({ proof: 'p', serverTimeMs: 1, expiresAtMs: 2, sessions: [extra] }));
    expect(Object.keys(out.sessions[0])).toEqual(['s', 'label', 'state', 'cols', 'rows', 'q']);
  });
  it('snap, out, size, state', () => {
    expect(encodeSnap({ s: 'claude', q: 124, cols: 100, rows: 30, d: '\u001b[1mhi\u001b[0m\r\n' })).toBe(spec.frames.snap);
    expect(encodeOut({ s: 'claude', q: 125, d: '\u001b[32mok\u001b[0m\r\n' })).toBe(spec.frames.out);
    expect(encodeSize({ s: 'claude', cols: 120, rows: 40 })).toBe(spec.frames.size);
    expect(encodeState({ s: 'claude', state: 'running' })).toBe(spec.frames.state);
  });
  it('every titan-to-phone golden type is declared', () => {
    for (const k of ['welcome', 'bye', 'snap', 'out', 'size', 'state']) expect(spec.messages.titanToPhone).toContain(JSON.parse(spec.frames[k]).t);
  });
  it('attach, attachResume and detach goldens parse back', () => {
    expect(parsePhoneMessage(spec.frames.attach)).toEqual({ t: 'attach', s: 'claude' });
    expect(parsePhoneMessage(spec.frames.attachResume)).toEqual({ t: 'attach', s: 'claude', q: 123 });
    expect(parsePhoneMessage(spec.frames.detach)).toEqual({ t: 'detach', s: 'claude' });
  });
});

describe('parsePhoneMessage attach and detach (strict)', () => {
  const p = (o: unknown): ReturnType<typeof parsePhoneMessage> => parsePhoneMessage(JSON.stringify(o));
  it('rejects a missing or unknown slot, and an absurdly long one', () => {
    expect(p({ t: 'attach' })).toBeNull();
    expect(p({ t: 'detach' })).toBeNull();
    expect(p({ t: 'attach', s: 'nope' })).toBeNull();
    expect(p({ t: 'detach', s: 5 })).toBeNull();
    expect(p({ t: 'attach', s: 'x'.repeat(100) })).toBeNull();
  });
  it('rejects a q that is not a non-negative safe integer', () => {
    for (const q of ['5', '1e3', 1.5, -1, null, true, NaN, Infinity, 2 ** 53]) expect(p({ t: 'attach', s: 'claude', q })).toBeNull();
    expect(parsePhoneMessage('{"t":"attach","s":"claude","q":-0.5}')).toBeNull();
  });
  it('accepts q = 0 and the largest safe integer, and ignores extra keys', () => {
    expect(p({ t: 'attach', s: 'codex', q: 0 })).toEqual({ t: 'attach', s: 'codex', q: 0 });
    expect(p({ t: 'attach', s: 'codex', q: Number.MAX_SAFE_INTEGER })).toEqual({ t: 'attach', s: 'codex', q: Number.MAX_SAFE_INTEGER });
    expect(p({ t: 'attach', s: 'terminal2', fit: { cols: 80 }, x: 1 })).toEqual({ t: 'attach', s: 'terminal2' });
    expect(p({ t: 'detach', s: 'claude', q: 'junk' })).toEqual({ t: 'detach', s: 'claude' });
  });
});

describe('parsePhoneMessage', () => {
  const ok = { t: 'hello', v: 1, app: '0.2.0-v1', epoch: '0123456789abcdef', nonce: '00112233445566778899aabbccddeeff' };
  const parse = (o: unknown): ReturnType<typeof parsePhoneMessage> => parsePhoneMessage(JSON.stringify(o));

  it('ignores extra keys', () => {
    expect(parse({ ...ok, extra: 1 })).toEqual(ok);
  });

  it('rejects non-JSON, non-objects and unknown or missing types', () => {
    expect(parsePhoneMessage('not json')).toBeNull();
    expect(parsePhoneMessage('[]')).toBeNull();
    expect(parsePhoneMessage('null')).toBeNull();
    expect(parse({ ...ok, t: 'kill' })).toBeNull();
    expect(parse({ ...ok, t: 5 })).toBeNull();
    expect(parse({ v: 1 })).toBeNull();
  });

  it('rejects wrong version, app, epoch and nonce', () => {
    expect(parse({ ...ok, v: 2 })).toBeNull();
    expect(parse({ ...ok, v: '1' })).toBeNull();
    expect(parse({ ...ok, app: 'x'.repeat(33) })).toBeNull();
    expect(parse({ ...ok, app: 7 })).toBeNull();
    expect(parse({ ...ok, epoch: '0123456789ABCDEF' })).toBeNull();
    expect(parse({ ...ok, epoch: '0123456789abcde' })).toBeNull();
    expect(parse({ ...ok, nonce: '00112233445566778899aabbccddeef' })).toBeNull();
    expect(parse({ ...ok, nonce: 'g0112233445566778899aabbccddeeff' })).toBeNull();
  });

  it('normalises a JSON -0 attach q to +0', () => {
    const m = parsePhoneMessage('{"t":"attach","s":"claude","q":-0}');
    expect(m).toMatchObject({ t: 'attach', s: 'claude' });
    expect(Object.is((m as { q: number }).q, 0)).toBe(true);
  });

  it('accepts an app string of exactly 32 characters', () => {
    expect(parse({ ...ok, app: 'x'.repeat(32) })).not.toBeNull();
  });
});

describe('thread frames', () => {
  const g = (k: string) => spec.frames[k] as string;
  const snap = JSON.parse(g('tsnap'));
  const meta = snap.m as ThreadMeta;
  const entries = snap.entries as ThreadEntry[];

  it('tattach, tdetach and tget goldens parse back', () => {
    expect(parsePhoneMessage(g('tattach'))).toEqual(JSON.parse(g('tattach')));
    expect(parsePhoneMessage(g('tdetach'))).toEqual(JSON.parse(g('tdetach')));
    expect(parsePhoneMessage(g('tget'))).toEqual(JSON.parse(g('tget')));
  });
  it('a bad slot (codex, unknown, missing) is not a thread frame', () => {
    for (const t of ['tattach', 'tdetach']) {
      for (const s of ['codex', 'nope', 7, null]) expect(parsePhoneMessage(JSON.stringify({ t, s }))).toBeNull();
      expect(parsePhoneMessage(JSON.stringify({ t }))).toBeNull();
    }
    expect(parsePhoneMessage('{"t":"tget","s":"codex","id":"1:0"}')).toBeNull();
  });
  it('tget id must match digits:digits', () => {
    for (const id of ['', 'abc', '12', '1:', ':1', '1:2:3', '-1:0', '1234567890123:0', '1:12345', '../x', '1:0\n', 12]) {
      expect(parsePhoneMessage(JSON.stringify({ t: 'tget', s: 'claude', id }))).toBeNull();
    }
    expect(parsePhoneMessage('{"t":"tget","s":"terminal2","id":"1:0"}')).toEqual({ t: 'tget', s: 'terminal2', id: '1:0' });
    expect(parsePhoneMessage('{"t":"tget","s":"claude"}')).toBeNull();
  });
  it('extra keys on tattach are ignored', () => {
    expect(parsePhoneMessage('{"t":"tattach","s":"claude","q":5,"junk":true}')).toEqual({ t: 'tattach', s: 'claude' });
  });
  it('tsnap, tadd, tupd, tmeta and tdet are reproduced byte for byte', () => {
    expect(encodeTsnap({ s: 'claude', q: 57, avail: true, why: null, entries, m: meta })).toBe(g('tsnap'));
    expect(encodeTadd({ s: 'claude', q: 58, e: entries[1] })).toBe(g('tadd'));
    expect(encodeTupd({ s: 'claude', q: 59, e: { ...(entries[4] as Extract<ThreadEntry, { k: 't' }>), st: 'ok', sz: 512, d: true } })).toBe(g('tupd'));
    expect(encodeTmeta({ s: 'claude', m: meta })).toBe(g('tmeta'));
    expect(encodeTdet({ s: 'claude', id: '500:0', input: 'npm test', inMore: 0, x: 'PASS 12 tests', more: 0 })).toBe(g('tdet'));
    expect(encodeTdet({ s: 'claude', id: '999:0', input: null, inMore: 0, x: null, more: 0 })).toBe(g('tdetNull'));
  });
  it('an unavailable snapshot sends no entries even if some are passed', () => {
    const empty: ThreadMeta = { ctxTok: null, ctxPct: null, work: 'unknown', since: null, tok: null, last: null, wait: null };
    expect(encodeTsnap({ s: 'terminal2', q: 0, avail: false, why: 'no-session', entries, m: empty })).toBe(g('tsnapUnavailable'));
  });
  it('entries are rebuilt key by key, so a stray property never reaches the wire', () => {
    const dirty = { ...entries[0], cwd: 'C:/secret', sessionId: 'abc' } as unknown as ThreadEntry;
    const out = JSON.parse(encodeTadd({ s: 'claude', q: 1, e: dirty }));
    expect(Object.keys(out.e)).toEqual(['id', 'ts', 'k', 'x', 'tr']);
  });
  it('welcome carries caps only when given, and stays byte-identical otherwise', () => {
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs, caps: ['thread'] })).toBe(g('welcomeCaps'));
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs, caps: [] })).toBe(spec.frames.welcome);
  });
  it('threadEntriesJsonLength is the JSON text length of the entries array', () => {
    expect(threadEntriesJsonLength(entries)).toBe(JSON.stringify(snap.entries).length);
    expect(threadEntriesJsonLength([])).toBe(2);
  });
});
