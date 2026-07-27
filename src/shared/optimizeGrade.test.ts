import { describe, it, expect } from 'vitest';
import { gradeBreakdown, appliedSummary, BAD_THRESHOLD_PER_WEEK, summarizeOptimize } from './optimizeGrade';
import { type OptimizeFinding } from './optimizeRules';

describe('gradeBreakdown', () => {
  it('no findings + healthy cache -> all good, fixed order', () => {
    const rows = gradeBreakdown({ findings: [], cacheHitRate: 0.85 });
    expect(rows.map((r) => r.key)).toEqual(['model-routing', 'file-pinning', 'output-caps', 'context-hygiene']);
    expect(rows.every((r) => r.status === 'good')).toBe(true);
  });

  it('finding present -> warn below threshold, bad at/above it, note carries $/wk', () => {
    const rows = gradeBreakdown({
      findings: [
        { id: 'opus-on-trivial-turns', estSavingsPerWeek: BAD_THRESHOLD_PER_WEEK } as OptimizeFinding,
        { id: 'uncapped-bash-output', estSavingsPerWeek: 5 } as OptimizeFinding,
      ],
      cacheHitRate: 0.8,
    });
    expect(rows[0].status).toBe('bad');
    expect(rows[2].status).toBe('warn');
    expect(rows[2].note).toMatch(/\$5/);
    expect(rows[1].status).toBe('good'); // file-pinning absent
  });

  it('context hygiene tiers on cacheHitRate', () => {
    expect(gradeBreakdown({ findings: [], cacheHitRate: 0.7 })[3].status).toBe('good');
    expect(gradeBreakdown({ findings: [], cacheHitRate: 0.5 })[3].status).toBe('warn');
    expect(gradeBreakdown({ findings: [], cacheHitRate: 0.1 })[3].status).toBe('bad');
    expect(gradeBreakdown({ findings: [], cacheHitRate: NaN })[3].status).toBe('warn');
  });

  it('gradeBreakdown tolerates missing args', () => {
    const rows = gradeBreakdown();
    expect(rows.length).toBe(4);
    expect(rows[3].status).toBe('warn');
  });

  it('gradeBreakdown: only the three $/wk factors are scored; context hygiene is not', () => {
    const rows = gradeBreakdown({ findings: [], cacheHitRate: 0.85 });
    expect(rows.map((r) => r.scored)).toEqual([true, true, true, false]);
  });

  it('appliedSummary counts and sums only applied findings', () => {
    const out = appliedSummary([
      { id: 'a', applied: true, estSavingsPerWeek: 12.5 } as any,
      { id: 'b', applied: false, estSavingsPerWeek: 100 } as any,
      { id: 'c', applied: true, estSavingsPerWeek: 7.5 } as any,
      { id: 'd', applied: true } as any, // no savings figure
    ]);
    expect(out).toEqual({ count: 3, totalPerWeek: 20 });
  });

  it('appliedSummary tolerates non-array input', () => {
    expect(appliedSummary(undefined)).toEqual({ count: 0, totalPerWeek: 0 });
  });
});

describe('summarizeOptimize', () => {
  it('sums estSavingsPerWeek across findings', () => {
    const findings = [
      { estSavingsPerWeek: 3.5 } as OptimizeFinding,
      { estSavingsPerWeek: 4 } as OptimizeFinding,
      { estSavingsPerWeek: 1.25 } as OptimizeFinding,
    ];
    expect(summarizeOptimize(findings).totalPerWeek).toBe(8.75);
  });

  it('empty findings -> total 0 and grade A', () => {
    expect(summarizeOptimize([])).toEqual({ totalPerWeek: 0, grade: 'A' });
  });

  it('grade A below 10', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 9.99 } as OptimizeFinding]).grade).toBe('A');
  });

  it('grade boundary: 10 -> B', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 10 } as OptimizeFinding]).grade).toBe('B');
  });

  it('grade B below 25', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 24.99 } as OptimizeFinding]).grade).toBe('B');
  });

  it('grade boundary: 25 -> C', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 25 } as OptimizeFinding]).grade).toBe('C');
  });

  it('grade C below 50', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 49.99 } as OptimizeFinding]).grade).toBe('C');
  });

  it('grade boundary: 50 -> D', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 50 } as OptimizeFinding]).grade).toBe('D');
  });

  it('grade D above 50', () => {
    expect(summarizeOptimize([{ estSavingsPerWeek: 120 } as OptimizeFinding]).grade).toBe('D');
  });
});
