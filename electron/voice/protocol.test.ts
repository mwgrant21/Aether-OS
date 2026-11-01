// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, encodeEvent, parseClientMessage, type ServerEvent } from './protocol';

const J = JSON.stringify;
const TID = 'turn-0001';

describe('parseClientMessage valid', () => {
  const valid: Array<[string, unknown]> = [
    ['turn.start', { t: 'turn.start', turnId: TID, text: 'hello', mode: 'voice' }],
    ['turn.start max text', { t: 'turn.start', turnId: 'a'.repeat(64), text: 'x'.repeat(4000), mode: 'voice' }],
    ['turn.cancel', { t: 'turn.cancel', turnId: TID, spokenText: '' }],
    ['turn.cancel max spoken', { t: 'turn.cancel', turnId: TID, spokenText: 'y'.repeat(2000) }],
    ['permission.reply', { t: 'permission.reply', id: 'p1', approve: false }],
    ['resume', { t: 'resume', lastSeq: 0 }],
    ['resume with sessionId', { t: 'resume', lastSeq: 12, sessionId: 'abc' }],
  ];
  it.each(valid)('%s', (_n, m) => {
    expect(parseClientMessage(J(m))).toEqual(m);
  });
});

describe('parseClientMessage invalid', () => {
  const ts = { t: 'turn.start', turnId: TID, text: 'hi', mode: 'voice' };
  const bad: Array<[string, string]> = [
    ['text 4001', J({ ...ts, text: 'x'.repeat(4001) })],
    ['text empty', J({ ...ts, text: '' })],
    ['turnId 7 chars', J({ ...ts, turnId: 'abcdefg' })],
    ['turnId 65 chars', J({ ...ts, turnId: 'a'.repeat(65) })],
    ['turnId bad chars', J({ ...ts, turnId: 'abcd efgh' })],
    ['mode other', J({ ...ts, mode: 'text' })],
    ['cancel spoken 2001', J({ t: 'turn.cancel', turnId: TID, spokenText: 'z'.repeat(2001) })],
    ['cancel spoken not string', J({ t: 'turn.cancel', turnId: TID, spokenText: 5 })],
    ['perm id empty', J({ t: 'permission.reply', id: '', approve: true })],
    ['perm id 65', J({ t: 'permission.reply', id: 'i'.repeat(65), approve: true })],
    ['approve "yes"', J({ t: 'permission.reply', id: 'p1', approve: 'yes' })],
    ['lastSeq -1', J({ t: 'resume', lastSeq: -1 })],
    ['lastSeq 1.5', J({ t: 'resume', lastSeq: 1.5 })],
    ["lastSeq '1'", J({ t: 'resume', lastSeq: '1' })],
    ['sessionId number', J({ t: 'resume', lastSeq: 1, sessionId: 3 })],
    ['unknown t', J({ t: 'nope' })],
    ['missing t', J({ turnId: TID })],
    ['array', '[]'],
    ['null', 'null'],
    ['number', '5'],
    ['string', '"turn.start"'],
    ['not json', '{oops'],
    ['empty', ''],
    ['17 KiB string', J({ ...ts, text: 'x'.repeat(17 * 1024) })],
  ];
  it.each(bad)('%s -> null', (_n, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('never throws on non-string input', () => {
    for (const v of [undefined, null, 5, {}, []]) {
      expect(() => parseClientMessage(v as unknown as string)).not.toThrow();
      expect(parseClientMessage(v as unknown as string)).toBeNull();
    }
  });

  it('treats a __proto__ key as data, not a message', () => {
    expect(parseClientMessage('{"__proto__":{"t":"resume","lastSeq":1}}')).toBeNull();
  });
});

describe('parseClientMessage key picking', () => {
  it('does not copy extra keys', () => {
    const r = parseClientMessage(J({ t: 'turn.start', turnId: TID, text: 'hi', mode: 'voice', evil: 1 }));
    expect(Object.keys(r as object).sort()).toEqual(['mode', 't', 'text', 'turnId']);
    const r2 = parseClientMessage(J({ t: 'resume', lastSeq: 1, extra: true }));
    expect(Object.keys(r2 as object).sort()).toEqual(['lastSeq', 't']);
  });
});

describe('encodeEvent', () => {
  it('round trips', () => {
    const e: ServerEvent = { t: 'turn.completed', sessionId: 's', turnId: TID, seq: 3, status: 'lost', spokenText: 'ok' };
    expect(JSON.parse(encodeEvent(e))).toEqual(e);
  });
});

describe('ERROR_CODES', () => {
  it('matches the contract list', () => {
    expect([...ERROR_CODES]).toEqual([
      'bad_message', 'busy', 'session_starting', 'session_restarting', 'session_down',
      'session_changed', 'resume_gap', 'turn_failed', 'replaced',
    ]);
  });
});

describe('purity', () => {
  it.each(['./protocol.ts', '../../src/shared/voice/types.ts'])('%s imports no host modules', (rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const m of ['electron', 'node:fs', 'ws', 'node:child_process']) {
      expect(src).not.toMatch(new RegExp(`from\\s+['"]${m}['"]`));
    }
  });
});
