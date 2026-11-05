// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS, applyAmendments, canonicalSha256, termsSha256, validateTerms } from './terms.mjs';
const w = (over: Record<string, unknown>) => ({ ...DEFAULT_TERMS, ...over });
describe('DEFAULT_TERMS', () => {
  it('matches design section 5 and is frozen', () => {
    expect(DEFAULT_TERMS).toMatchObject({
      window: { start: '01:00', end: '07:00' }, push: true, merge: 'gated', delete: false, forcePush: false,
      codexReviewsPerPush: 3, opusEscalation: false, fableElevation: false, notifications: 'silent',
    });
    expect(Object.isFrozen(DEFAULT_TERMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TERMS.window)).toBe(true);
  });
});
describe('validateTerms', () => {
  it('accepts the defaults', () => {
    const r = validateTerms(structuredClone(DEFAULT_TERMS));
    expect(r.ok && r.terms).toEqual(DEFAULT_TERMS);
  });
  it.each([
    ['delete true', w({ delete: true }), 'delete'],
    ['forcePush true', w({ forcePush: true }), 'forcePush'],
    ['4 reviews', w({ codexReviewsPerPush: 4 }), 'codexReviewsPerPush'],
    ['fractional reviews', w({ codexReviewsPerPush: 1.5 }), 'codexReviewsPerPush'],
    ['bad clock', w({ window: { start: '25:00', end: '07:00' } }), 'window'],
    ['zero-length window', w({ window: { start: '01:00', end: '01:00' } }), 'window'],
    ['fable without opus', w({ fableElevation: true, opusEscalation: false }), 'fableElevation'],
    ['unknown key', w({ bypassPermissions: true }), 'bypassPermissions'],
    ['loud notifications', w({ notifications: 'toast' }), 'notifications'],
    ['bad merge mode', w({ merge: 'always' }), 'merge'],
    ['missing key', (() => { const { push: _p, ...rest } = DEFAULT_TERMS; return rest; })(), 'push'],
    ['not an object', 'x', 'object'],
    ['array', [], 'object'],
  ])('rejects %s', (_n, input, key) => {
    const r = validateTerms(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain(key);
  });
});
describe('applyAmendments', () => {
  it('applies an amendable key without mutating the base', () => {
    const r = applyAmendments(DEFAULT_TERMS, { opusEscalation: true, window: { start: '00:30', end: '06:00' } });
    expect(r.ok && r.terms.opusEscalation).toBe(true);
    expect(r.ok && r.terms.window.start).toBe('00:30');
    expect(DEFAULT_TERMS.opusEscalation).toBe(false);
  });
  it.each(['delete', 'forcePush', 'notifications', 'v'])('refuses to amend %s', (k) => {
    const r = applyAmendments(DEFAULT_TERMS, { [k]: k === 'v' ? 2 : true });
    expect(r.ok).toBe(false);
  });
  it('re-validates the merged result (fable on with opus off)', () => {
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true }).ok).toBe(false);
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true, opusEscalation: true }).ok).toBe(true);
  });
});
describe('termsSha256', () => {
  it('ignores key order and changes with any value', () => {
    const a = termsSha256(DEFAULT_TERMS);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_TERMS).reverse());
    expect(termsSha256(reordered as typeof DEFAULT_TERMS)).toBe(a);
    expect(termsSha256({ ...DEFAULT_TERMS, push: false })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSha256({ b: { y: 1, x: 2 }, a: [1] })).toBe(canonicalSha256({ a: [1], b: { x: 2, y: 1 } }));   // nested key order is ignored too
  });
});
