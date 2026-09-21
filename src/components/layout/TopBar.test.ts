import { describe, it, expect } from 'vitest';
import { resolveScopePillLabel, scopePillStyle, opModeStyle } from './TopBar';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import { colors, motion } from '../../styles/tokens';

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
    expect(resolveScopePillLabel({ selectedProject: 'aether#wt', projectsSnapshot: snapshot })).toBe('aether-os · statusline-feed');
  });

  it('returns null when the selected key is no longer in the snapshot', () => {
    expect(resolveScopePillLabel({ selectedProject: 'deleted', projectsSnapshot: snapshot })).toBeNull();
  });

  it('returns null when there is no snapshot yet', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether', projectsSnapshot: null })).toBeNull();
  });
});

describe('scopePillStyle', () => {
  it('marks the pill as non-draggable so Electron treats clicks on it as clicks, not window-drag', () => {
    const style = scopePillStyle(colors);
    expect(style.WebkitAppRegion).toBe('no-drag');
  });
});

describe('opModeStyle transition', () => {
  // `all` animates every property that ever changes, including layout ones a
  // future edit might add; these four are what actually vary with `on`.
  it('names explicit properties instead of transitioning all', () => {
    const t = String(opModeStyle(colors, true, 'AUTO').transition);
    expect(t).not.toContain('all ');
    ['color', 'background', 'box-shadow', 'border-color'].forEach((prop) =>
      expect(t).toContain(prop),
    );
  });

  it('uses the shared motion scale rather than a retyped duration', () => {
    const t = String(opModeStyle(colors, false, 'PLAN').transition);
    expect(t).toContain(motion.duration.fast);
    expect(t).toContain(motion.easing.standard);
  });
});
