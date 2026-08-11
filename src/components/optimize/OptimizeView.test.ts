import { describe, it, expect } from 'vitest';
import { resolveOptimizeViewData } from './OptimizeView';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import type { OptimizeFinding } from '../../shared/optimizeRules';

describe('resolveOptimizeViewData', () => {
  const globalFinding: OptimizeFinding = {
    id: 'opus-on-trivial-turns',
    title: 'global finding',
    detail: '',
    estSavingsPerWeek: 5,
    fixText: '',
  };
  const scopedFinding: OptimizeFinding = {
    id: 'cost-of-thrash',
    title: 'scoped finding',
    detail: '',
    estSavingsPerWeek: 2,
    fixText: '',
  };
  const globalState = {
    optimizeFindings: [globalFinding],
    optimizeSummary: { totalPerWeek: 5, grade: 'B' as const },
    optimizeBreakdown: [],
  };
  const snapshot: ProjectsSnapshot = {
    roots: [
      {
        key: 'aether', name: 'aether-os', worktree: null,
        ledger: {} as any,
        optimize: { findings: [scopedFinding], summary: { totalPerWeek: 2, grade: 'A' as const }, breakdown: [] },
        children: [],
      },
    ],
    unscoped: null,
    computedAtMs: 0,
  };

  it('returns the global findings when nothing is selected', () => {
    const result = resolveOptimizeViewData({ selectedProject: null, projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toBe(globalState.optimizeFindings);
  });

  it('returns the scoped project\'s findings when a valid project is selected', () => {
    const result = resolveOptimizeViewData({ selectedProject: 'aether', projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toEqual([scopedFinding]);
    expect(result.summary.grade).toBe('A');
  });

  it('falls back to global findings when the selected key is no longer in the snapshot', () => {
    const result = resolveOptimizeViewData({ selectedProject: 'deleted', projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toBe(globalState.optimizeFindings);
  });
});
