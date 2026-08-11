import { describe, it, expect, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { ProjectDetailCard } from './ProjectDetailCard';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}
afterEach(cleanup);

const ledger = (usd: number) =>
  ({
    total: { usd, breakdown: { input: usd * 0.9, output: usd * 0.1, cacheCreation: 0, cacheRead: 0 } },
    tiers: ['sonnet' as const],
    rollups: { today: usd / 4, week: usd / 2, month: usd * 1.5 },
    cache: { cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 },
    cacheHitRate: 0,
    timeZone: 'UTC',
    computedAtMs: 0,
  });

const optimize = {
  findings: [],
  summary: { totalPerWeek: 0, grade: 'A' as const },
  breakdown: [],
};

const snapshot: ProjectsSnapshot = {
  roots: [
    {
      key: 'aether', name: 'Aether-OS', worktree: null, ledger: ledger(184.2), optimize,
      children: [
        { key: 'aether-main', name: 'Aether-OS', worktree: null, ledger: ledger(31.05), optimize },
        { key: 'aether-wt', name: 'Aether-OS', worktree: 'statusline-feed', ledger: ledger(153.15), optimize },
      ],
    },
    { key: 'tmv2', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4), optimize, children: [
      { key: 'tmv2-main', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4), optimize },
    ] },
  ],
  unscoped: ledger(44.9),
  computedAtMs: 0,
};

describe('ProjectDetailCard', () => {
  it('shows the project name, its cost breakdown and its rollup', () => {
    render(<ProjectDetailCard node={snapshot.roots[0]} />);
    expect(screen.getByText(/Aether-OS/)).toBeTruthy();
    expect(screen.getByText('$184.20')).toBeTruthy();
  });

  it('labels a worktree node with its worktree name', () => {
    render(<ProjectDetailCard node={snapshot.roots[0].children[1]} />);
    expect(screen.getByText(/statusline-feed/)).toBeTruthy();
  });

  it('prompts for a selection when none is made', () => {
    render(<ProjectDetailCard node={null} />);
    expect(screen.getByText(/select a project/i)).toBeTruthy();
  });
});
