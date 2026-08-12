import { describe, it, expect, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AetherStoreProvider } from '../../state/store';
import { ProjectRosterCard } from './ProjectRosterCard';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

function render(ui: ReactNode) {
  return rtlRender(<AetherStoreProvider>{ui}</AetherStoreProvider>);
}
// No Vitest globals in this suite, so RTL never registers its own cleanup.
afterEach(cleanup);

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

const optimize = {
  findings: [],
  summary: { totalPerWeek: 0, grade: 'A' as const },
  breakdown: [],
};

const snapshot: ProjectsSnapshot = {
  roots: [
    {
      key: 'aether', name: 'aether-os', worktree: null, ledger: ledger(184.2), optimize,
      children: [
        { key: 'aether-main', name: 'aether-os', worktree: null, ledger: ledger(31.05), optimize },
        { key: 'aether-wt', name: 'aether-os', worktree: 'statusline-feed', ledger: ledger(153.15), optimize },
      ],
    },
    { key: 'tmv2', name: 'tokenmonitorv2', worktree: null, ledger: ledger(96.4), optimize, children: [
      { key: 'tmv2-main', name: 'tokenmonitorv2', worktree: null, ledger: ledger(96.4), optimize },
    ] },
  ],
  unscoped: ledger(44.9),
  computedAtMs: 0,
};

describe('ProjectRosterCard', () => {
  it('lists roots with their combined cost', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText('aether-os')).toBeTruthy();
    expect(screen.getByText('$184.20')).toBeTruthy();
    expect(screen.getByText('$96.40')).toBeTruthy();
  });

  it('hides worktree children until the root is expanded', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByText('statusline-feed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /expand aether-os/i }));
    expect(screen.getByText('statusline-feed')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('offers no disclosure control for a repo with only its own checkout', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByRole('button', { name: /expand tokenmonitorv2/i })).toBeNull();
  });

  it('renders the unscoped bucket, and does not call it a project', () => {
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText(/unscoped/i)).toBeTruthy();
    expect(screen.getByText('$44.90')).toBeTruthy();
  });

  it('omits the unscoped row entirely when there is nothing unattributable', () => {
    render(<ProjectRosterCard snapshot={{ ...snapshot, unscoped: null }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByText(/unscoped/i)).toBeNull();
  });

  it('reports the clicked key', () => {
    const onSelect = vi.fn();
    render(<ProjectRosterCard snapshot={snapshot} selectedKey={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('tokenmonitorv2'));
    expect(onSelect).toHaveBeenCalledWith('tmv2');
  });

  it('says so plainly when no projects have been observed', () => {
    render(<ProjectRosterCard snapshot={{ roots: [], unscoped: null, computedAtMs: 0 }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText(/no projects observed/i)).toBeTruthy();
  });

  it('renders the unscoped row instead of the empty state when roots is empty but unscoped activity exists', () => {
    render(<ProjectRosterCard snapshot={{ roots: [], unscoped: ledger(44.9), computedAtMs: 0 }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.queryByText(/no projects observed/i)).toBeNull();
    expect(screen.getByText(/unscoped/i)).toBeTruthy();
    expect(screen.getByText('$44.90')).toBeTruthy();
  });

  it('still shows the empty state when both roots and unscoped are empty/null', () => {
    render(<ProjectRosterCard snapshot={{ roots: [], unscoped: null, computedAtMs: 0 }} selectedKey={null} onSelect={() => {}} />);
    expect(screen.getByText(/no projects observed yet/i)).toBeTruthy();
  });
});
