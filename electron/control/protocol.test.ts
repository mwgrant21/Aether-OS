// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MESSAGE_TYPES, PROTOCOL_VERSION, encodeAck, encodeBye, encodeNak, encodeOut, encodePrompt, encodePromptClosed, encodeSize, encodeSnap, encodeState, encodeThreadEv, encodeThreadSnap, encodeThreadState, encodeWelcome, parsePhoneMessage, validateInput } from './protocol';
import { CONTROL_BYE_REASONS, CONTROL_MESSAGE_TYPES, CONTROL_PROMPT_CLOSE_REASONS, PROMPT_SUMMARY_CAP, THREAD_SNAPSHOT_MAX_BYTES, THREAD_SNAPSHOT_MAX_EVENTS, THREAD_TARGET_CAP, THREAD_TEXT_CAP, THREAD_WORKING_STALE_MS } from '../../src/shared/remote/types';
import type { TerminalInfo, ThreadEvent } from '../../src/shared/remote/types';

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
    for (const k of ['welcome', 'bye', 'snap', 'out', 'size', 'state', 'ack']) expect(spec.messages.titanToPhone).toContain(JSON.parse(spec.frames[k]).t);
  });
  it('attach, attachResume and detach goldens parse back', () => {
    expect(parsePhoneMessage(spec.frames.attach)).toEqual({ t: 'attach', s: 'claude' });
    expect(parsePhoneMessage(spec.frames.attachResume)).toEqual({ t: 'attach', s: 'claude', q: 123 });
    expect(parsePhoneMessage(spec.frames.detach)).toEqual({ t: 'detach', s: 'claude' });
  });
});

describe('input verbs', () => {
  const p = (o: unknown): ReturnType<typeof parsePhoneMessage> => parsePhoneMessage(JSON.stringify(o));
  it('golden in parses back and round-trips', () => {
    const m = parsePhoneMessage(spec.frames.in);
    expect(m).toEqual({ t: 'in', s: 'claude', c: 1, d: 'echo hi\r' });
    expect(JSON.stringify(m)).toBe(spec.frames.in);
  });
  it('golden ack and welcomeApplied are reproduced byte for byte', () => {
    expect(encodeAck({ s: 'claude', c: 3 })).toBe(spec.frames.ack);
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs, applied: { claude: 3 } })).toBe(spec.frames.welcomeApplied);
  });
  it('golden nak frames are reproduced byte for byte', () => {
    expect(encodeNak({ s: 'claude', c: 4, reason: 'not-running' })).toBe(spec.frames.nakNotRunning);
    expect(encodeNak({ s: 'terminal2', c: 9, reason: 'typing-off' })).toBe(spec.frames.nakTypingOff);
  });
  it('rejects a cseq that is not a safe integer >= 1', () => {
    for (const c of [0, 1.5, -1, '1', null, NaN, 2 ** 53]) expect(p({ t: 'in', s: 'claude', c, d: 'a' })).toBeNull();
    expect(p({ t: 'in', s: 'claude', d: 'a' })).toBeNull();
    expect(p({ t: 'in', s: 'claude', c: Number.MAX_SAFE_INTEGER, d: 'a' })).not.toBeNull();
  });
  it('rejects an empty, non-string, oversize or lone-surrogate d', () => {
    expect(p({ t: 'in', s: 'claude', c: 1, d: '' })).toBeNull();
    expect(p({ t: 'in', s: 'claude', c: 1, d: 5 })).toBeNull();
    expect(p({ t: 'in', s: 'claude', c: 1, d: 'a'.repeat(8193) })).toBeNull();
    expect(p({ t: 'in', s: 'claude', c: 1, d: 'a'.repeat(8192) })).not.toBeNull();
    expect(p({ t: 'in', s: 'claude', c: 1, d: '€'.repeat(2731) })).toBeNull(); // 8193 bytes in 2731 UTF-16 units
    expect(parsePhoneMessage('{"t":"in","s":"claude","c":1,"d":"x\\ud800"}')).toBeNull();
  });
  it('rejects an unknown slot and ignores extra keys', () => {
    expect(p({ t: 'in', s: 'nope', c: 1, d: 'a' })).toBeNull();
    expect(p({ t: 'in', s: 'codex', c: 2, d: 'a', x: 1 })).toEqual({ t: 'in', s: 'codex', c: 2, d: 'a' });
  });
  it('validateInput accepts control bytes, escapes and emoji, and throws RangeError on a lone surrogate', () => {
    for (const d of ['\x03', '\x1b[A', '\x7f', '\0', '😀']) expect(validateInput(d)).toBe(d);
    expect(() => validateInput('\ud800')).toThrow(RangeError);
    expect(() => validateInput('')).toThrow(RangeError);
    expect(() => validateInput(undefined)).toThrow(RangeError);
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

describe('thread and prompt frames', () => {
  const p = (o: unknown): ReturnType<typeof parsePhoneMessage> => parsePhoneMessage(JSON.stringify(o));
  const ev = JSON.parse(spec.frames.threadSnap).events as ThreadEvent[];
  it('thread.attach and thread.detach goldens parse back and round-trip', () => {
    expect(parsePhoneMessage(spec.frames.threadAttach)).toEqual({ t: 'thread.attach', s: 'claude' });
    expect(parsePhoneMessage(spec.frames.threadDetach)).toEqual({ t: 'thread.detach', s: 'claude' });
    expect(JSON.stringify(parsePhoneMessage(spec.frames.threadAttach))).toBe(spec.frames.threadAttach);
  });
  it('a non-claude or missing slot is an invalid frame', () => {
    for (const t of ['thread.attach', 'thread.detach']) {
      for (const s of ['terminal2', 'codex', 5, null, undefined]) expect(p({ t, s })).toBeNull();
    }
    expect(p({ t: 'thread.attach', s: 'claude', x: 1 })).toEqual({ t: 'thread.attach', s: 'claude' });
  });
  it('encoders reproduce the goldens byte for byte', () => {
    const snap = JSON.parse(spec.frames.threadSnap);
    expect(encodeThreadSnap({ s: 'claude', q: 7, attached: true, working: true, workingSinceMs: 1790000000000, events: ev })).toBe(spec.frames.threadSnap);
    expect(encodeThreadEv({ s: 'claude', q: 8, events: JSON.parse(spec.frames.threadEv).events })).toBe(spec.frames.threadEv);
    expect(encodeThreadState({ s: 'claude', q: 9, working: false, workingSinceMs: null })).toBe(spec.frames.threadState);
    const pr = JSON.parse(spec.frames.prompt);
    expect(encodePrompt({ id: pr.id, tool: 'Bash', risk: 'MED', summary: './gradlew test', ttlMs: 102000 })).toBe(spec.frames.prompt);
    expect(encodePromptClosed({ id: pr.id, reason: 'answered-desktop' })).toBe(spec.frames.promptClosed);
    expect(snap.events).toHaveLength(3);
  });
  it('an event is re-shaped to the fixed key order and absent target/add/del become null', () => {
    const loose = { id: '1:0', k: 'tool', name: 'Read', at: 5, extra: 1 } as unknown as ThreadEvent;
    expect(JSON.parse(encodeThreadEv({ s: 'claude', q: 1, events: [loose] })).events[0]).toEqual({ k: 'tool', id: '1:0', at: 5, name: 'Read', target: null, add: null, del: null });
    expect(Object.keys(JSON.parse(encodeThreadEv({ s: 'claude', q: 1, events: [loose] })).events[0])).toEqual(['k', 'id', 'at', 'name', 'target', 'add', 'del']);
  });
  it('every thread golden type is declared and the constants equal the JSON thread section', () => {
    for (const k of ['threadSnap', 'threadEv', 'threadState', 'prompt', 'promptClosed']) expect(spec.messages.titanToPhone).toContain(JSON.parse(spec.frames[k]).t);
    for (const k of ['threadAttach', 'threadDetach']) expect(spec.messages.phoneToTitan).toContain(JSON.parse(spec.frames[k]).t);
    expect(spec.thread).toEqual({
      slot: 'claude', snapshotMaxEvents: THREAD_SNAPSHOT_MAX_EVENTS, textCap: THREAD_TEXT_CAP, targetCap: THREAD_TARGET_CAP,
      snapshotMaxBytes: THREAD_SNAPSHOT_MAX_BYTES, promptSummaryCap: PROMPT_SUMMARY_CAP, workingStaleMs: THREAD_WORKING_STALE_MS,
    });
    expect(spec.messages.promptCloseReasons).toEqual([...CONTROL_PROMPT_CLOSE_REASONS]);
  });
});
