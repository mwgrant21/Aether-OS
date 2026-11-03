import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { usageFromSnapshot, aliasFromModel, judgeReadback } from './readback';
import type { Readback } from './readback';
import type { StatuslineSnapshot } from '../statuslinePayload';
import type { Pick } from './types';

const NOW = 10_000_000;
function snap(o: Partial<StatuslineSnapshot> = {}): StatuslineSnapshot {
  return {
    capturedAtMs: NOW - 1000,
    modelId: null,
    modelDisplayName: null,
    fiveHour: { usedPercentage: 40, resetsAtMs: NOW + 1000 },
    sevenDay: { usedPercentage: 70, resetsAtMs: NOW + 1000 },
    ...o,
  } as StatuslineSnapshot;
}
const WANT: Pick = { model: 'sonnet', effort: 'medium' };
const SENT = 1000;

describe('usageFromSnapshot', () => {
  it('reads both windows from a fresh snapshot', () => {
    expect(usageFromSnapshot(snap(), NOW)).toEqual({ sessionPct: 40, weekPct: 70, known: true });
  });
  it('null snapshot is unknown', () => {
    expect(usageFromSnapshot(null, NOW)).toEqual({ sessionPct: 0, weekPct: 0, known: false });
  });
  it('snapshot older than 15 min is unknown with 0/0', () => {
    expect(usageFromSnapshot(snap({ capturedAtMs: NOW - 15 * 60_000 - 1 }), NOW)).toEqual({
      sessionPct: 0,
      weekPct: 0,
      known: false,
    });
  });
  it('one missing window reads 0 for it and stays known', () => {
    expect(usageFromSnapshot(snap({ sevenDay: null }), NOW)).toEqual({ sessionPct: 40, weekPct: 0, known: true });
  });
  it('both windows missing is unknown', () => {
    expect(usageFromSnapshot(snap({ fiveHour: null, sevenDay: null }), NOW).known).toBe(false);
  });
});

describe('aliasFromModel', () => {
  it('matches case-insensitively on either field', () => {
    expect(aliasFromModel({ modelId: null, modelDisplayName: 'Sonnet 5.5' })).toBe('sonnet');
    expect(aliasFromModel({ modelId: 'OPUS-x', modelDisplayName: null })).toBe('opus');
    expect(aliasFromModel({ modelId: 'x', modelDisplayName: 'Haiku' })).toBe('haiku');
  });
  it('other non-empty values are other', () => {
    expect(aliasFromModel({ modelId: null, modelDisplayName: 'Fable 5.1' })).toBe('other');
  });
  it('both empty is null', () => {
    expect(aliasFromModel({ modelId: null, modelDisplayName: '  ' })).toBeNull();
  });
});

describe('judgeReadback', () => {
  const rb = (o: Partial<Readback> = {}): Readback => ({
    model: 'sonnet',
    effort: 'medium',
    capturedAtMs: SENT + 5,
    ...o,
  });
  const j = (readback: Readback | null, nowMs = SENT + 10, extra: { onTimeout?: 'not-applied' } = {}) =>
    judgeReadback({ wanted: WANT, readback, sentAtMs: SENT, nowMs, ...extra });

  it('ignores a readback captured before the send', () => {
    expect(j(rb({ capturedAtMs: SENT - 1 })).kind).toBe('pending');
  });
  it('model and effort match is confirmed', () => {
    expect(j(rb())).toEqual({ kind: 'confirmed', actual: WANT });
  });
  it('model match with unknown effort is unconfirmed, never confirmed', () => {
    expect(j(rb({ effort: null })).kind).toBe('unconfirmed');
  });
  it('alias mismatch is not-applied with actual', () => {
    expect(j(rb({ model: 'opus' }))).toEqual({ kind: 'not-applied', actual: { model: 'opus', effort: 'medium' } });
  });
  it('other (fable) mismatch is not-applied with null actual', () => {
    expect(j(rb({ model: 'other' }))).toEqual({ kind: 'not-applied', actual: null });
  });
  it('effort mismatch is not-applied', () => {
    expect(j(rb({ effort: 'high' }))).toEqual({ kind: 'not-applied', actual: { model: 'sonnet', effort: 'high' } });
  });
  it('no readback before timeout is pending', () => {
    expect(j(null, SENT + 59_999).kind).toBe('pending');
  });
  it('no readback at timeout is unconfirmed by default, not-applied when asked', () => {
    expect(j(null, SENT + 60_000).kind).toBe('unconfirmed');
    expect(j(null, SENT + 60_000, { onTimeout: 'not-applied' }).kind).toBe('not-applied');
  });
});

describe('readback.ts source', () => {
  it('contains no literal Claude model id', () => {
    const src = readFileSync('src/shared/aetherChoice/readback.ts', 'utf8');
    expect(src).not.toMatch(/claude-[a-z]+-\d/);
  });
});
