import { describe, it, expect } from 'vitest';
import { computeSeverity } from './personalitySpine.js';

describe('computeSeverity', () => {
  it('exit ok, 0 retries, no median -> sev 1 (nominal baseline)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(1);
  });

  it('exit fatal dominates regardless of retries (retries=0)', () => {
    expect(computeSeverity({ exit: 'fatal', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(4);
  });

  it('exit fatal dominates regardless of retries (retries=5)', () => {
    expect(computeSeverity({ exit: 'fatal', retries: 5, elapsedMs: 1000, medianMsAtEval: null })).toBe(4);
  });

  it('exit blocked forces sev 4 unconditionally', () => {
    expect(computeSeverity({ exit: 'blocked', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(4);
  });

  it('retries >= 2 with exit ok -> sev 2 (dead in real Stage 11 data, but must be correct)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 2, elapsedMs: 1000, medianMsAtEval: null })).toBe(2);
  });

  it('retries == 1 with exit ok does NOT bump severity (threshold is >= 2)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 1, elapsedMs: 1000, medianMsAtEval: null })).toBe(1);
  });

  it('elapsedMs > 3x medianMsAtEval bumps sev by 1 (dead in real Stage 11 data: median always null)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 301, medianMsAtEval: 100 })).toBe(2);
  });

  it('elapsedMs exactly at 3x median does not bump (strictly greater than required)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 300, medianMsAtEval: 100 })).toBe(1);
  });

  it('exit partial -> sev = max(sev, 2)', () => {
    expect(computeSeverity({ exit: 'partial', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(2);
  });

  it('exit error -> sev = max(sev, 3)', () => {
    expect(computeSeverity({ exit: 'error', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(3);
  });

  it('exit timeout -> sev = max(sev, 3)', () => {
    expect(computeSeverity({ exit: 'timeout', retries: 0, elapsedMs: 1000, medianMsAtEval: null })).toBe(3);
  });

  it('findingWeights containing a 3 -> sev = max(sev, 3)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null, findingWeights: [1, 3] })).toBe(3);
  });

  it('findingWeights containing a 4 -> sev = max(sev, 4)', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null, findingWeights: [4] })).toBe(4);
  });

  it('findingWeights with no 3s or 4s does not bump severity', () => {
    expect(computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null, findingWeights: [1, 2] })).toBe(1);
  });

  it('undefined findingWeights behaves identically to an empty array (Stage 11 never passes non-empty)', () => {
    const withUndefined = computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null });
    const withEmpty = computeSeverity({ exit: 'ok', retries: 0, elapsedMs: 1000, medianMsAtEval: null, findingWeights: [] });
    expect(withUndefined).toBe(withEmpty);
  });

  it('order-sensitive: retries>=2 (+=1) combined with exit partial (max(sev,2)) -> sev 2, not 3', () => {
    // Per spec pseudocode order: sev starts at 1, retries>=2 bumps to 2 (+=1),
    // THEN exit:'partial' applies max(sev, 2) -> stays 2. A reordered implementation
    // that applied max() first (sev=max(1,2)=2) then += (sev=3) would wrongly yield 3.
    expect(computeSeverity({ exit: 'partial', retries: 2, elapsedMs: 1000, medianMsAtEval: null })).toBe(2);
  });

  it('combines retries and median bumps then exit max, clamped to [0,4]', () => {
    // sev=1, +=1 (median), +=1 (retries) => 3, then exit:'error' -> max(3,3)=3
    expect(computeSeverity({ exit: 'error', retries: 2, elapsedMs: 400, medianMsAtEval: 100 })).toBe(3);
  });

  it('combines retries, median, and a fatal exit, clamped at 4', () => {
    // sev=1, +=1, +=1 => 3, then exit:'fatal' -> max(3,4)=4, still clamped at 4
    expect(computeSeverity({ exit: 'fatal', retries: 2, elapsedMs: 400, medianMsAtEval: 100 })).toBe(4);
  });
});
