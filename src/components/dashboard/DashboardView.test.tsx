import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import { DashboardView } from './DashboardView';

// ReactorStatusCard renders <Reactor> and DigestSlot reads prefers-reduced-motion.
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function DispatchOnMount({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    actions.forEach((a) => dispatch(a));
  }, []);
  return <>{children}</>;
}
function renderDashboard(actions: Action[] = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={actions}>
        <DashboardView />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}
const AGENT = { toolUseId: 'tu-1', subagentType: 'Explore', description: 'scan', startedAt: new Date().toISOString(), prompt: 'p', model: null };

describe('DashboardView layout', () => {
  it('at a cold STANDBY shows READINESS and the strip beside the reactor, and no digest or SYSTEMS panel', () => {
    renderDashboard();
    const right = screen.getByTestId('dashboard-right-column');
    expect(within(right).getByRole('heading', { name: 'READINESS' })).toBeTruthy();
    expect(within(right).getAllByRole('button').map((b) => b.textContent)).toContain('Agents 0');
    expect(within(right).queryByRole('heading', { name: 'REACTOR STATUS' })).toBeNull();
    for (const name of ['ACTIVE AGENTS', 'PROJECTS', 'RECENT ALERTS', 'SYSTEMS']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
    }
  });

  it('turns a digest with data into a panel in the right column and drops it from the strip', () => {
    renderDashboard([{ type: 'SET_TERMINAL_ALIVE', alive: true }, { type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    const right = screen.getByTestId('dashboard-right-column');
    expect(within(right).getByRole('heading', { name: 'ACTIVE AGENTS' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agents 0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alerts 0' })).toBeTruthy();
  });

  it('puts a lone alert in RECENT ALERTS, leaving Projects in the strip', () => {
    renderDashboard([{ type: 'SET_OP_MODE', mode: 'EDITS' }]); // pushes a notif
    expect(screen.getByRole('heading', { name: 'RECENT ALERTS' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'PROJECTS' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alerts 0' })).toBeNull();
  });

  it('shows exactly one OPEN TERMINAL, under READINESS', () => {
    vi.stubGlobal('aetherElectron', {});
    renderDashboard();
    const buttons = screen.getAllByRole('button', { name: 'OPEN TERMINAL' });
    expect(buttons).toHaveLength(1);
    const readiness = screen.getByRole('heading', { name: 'READINESS' }).closest('section')!;
    expect(within(readiness).getByRole('button', { name: 'OPEN TERMINAL' })).toBe(buttons[0]);
  });
});
