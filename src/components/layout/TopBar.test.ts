import { describe, it, expect } from 'vitest';
import { resolveScopePillLabel } from './TopBar';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

describe('resolveScopePillLabel', () => {
  const snapshot: ProjectsSnapshot = {
    roots: [
      {
        key: 'aether', name: 'aether-os', worktree: null,
        ledger: {} as any,
        optimize: { findings: [], summary: { totalPerWeek: 0, grade: 'A' as const }, breakdown: [] },
        children: [
          {
            key: 'aether#wt', name: 'aether-os', worktree: 'statusline-feed',
            ledger: {} as any,
            optimize: { findings: [], summary: { totalPerWeek: 0, grade: 'A' as const }, breakdown: [] },
          },
        ],
      },
    ],
    unscoped: null,
    computedAtMs: 0,
  };

  it('returns null when nothing is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: null, projectsSnapshot: snapshot })).toBeNull();
  });

  it('returns the project name when a root is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether', projectsSnapshot: snapshot })).toBe('aether-os');
  });

  it('returns the project name when a child (worktree) is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether#wt', projectsSnapshot: snapshot })).toBe('aether-os');
  });

  it('returns null when the selected key is no longer in the snapshot', () => {
    expect(resolveScopePillLabel({ selectedProject: 'deleted', projectsSnapshot: snapshot })).toBeNull();
  });

  it('returns null when there is no snapshot yet', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether', projectsSnapshot: null })).toBeNull();
  });
});
