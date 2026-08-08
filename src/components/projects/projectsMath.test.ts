import { describe, it, expect } from 'vitest';
import { findProjectByKey } from './projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

const ledger = (usd: number) =>
  ({
    total: { usd, breakdown: { input: usd, output: 0, cacheCreation: 0, cacheRead: 0 } },
    tiers: ['sonnet' as const],
    rollups: { today: usd, week: usd, month: usd },
    cache: { cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 },
    cacheHitRate: 0,
    timeZone: 'UTC',
    computedAtMs: 0,
  });

const snapshot: ProjectsSnapshot = {
  roots: [
    {
      key: 'aether', name: 'Aether-OS', worktree: null, ledger: ledger(184.2),
      children: [
        { key: 'aether-main', name: 'Aether-OS', worktree: null, ledger: ledger(31.05) },
        { key: 'aether-wt', name: 'Aether-OS', worktree: 'statusline-feed', ledger: ledger(153.15) },
      ],
    },
    { key: 'tmv2', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4), children: [
      { key: 'tmv2-main', name: 'TokenMonitorV2', worktree: null, ledger: ledger(96.4) },
    ] },
  ],
  unscoped: ledger(44.9),
  computedAtMs: 0,
};

describe('findProjectByKey', () => {
  it('finds a root', () => {
    expect(findProjectByKey(snapshot, 'tmv2')?.name).toBe('TokenMonitorV2');
  });

  it('finds a nested worktree child', () => {
    expect(findProjectByKey(snapshot, 'aether-wt')?.worktree).toBe('statusline-feed');
  });

  // A persisted selection can outlive the project it named.
  it('returns null for a key absent from the snapshot', () => {
    expect(findProjectByKey(snapshot, 'deleted-project')).toBeNull();
  });

  it('returns null for a null snapshot or null key', () => {
    expect(findProjectByKey(null, 'aether')).toBeNull();
    expect(findProjectByKey(snapshot, null)).toBeNull();
  });

  it('defaults to the highest-cost root when nothing is selected', () => {
    expect(findProjectByKey(snapshot, null, { fallbackToFirst: true })?.name).toBe('Aether-OS');
  });
});
