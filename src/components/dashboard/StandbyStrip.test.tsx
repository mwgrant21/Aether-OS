import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import type { MemoryRow } from '../../state/types';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import { StandbyStrip } from './StandbyStrip';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function DispatchOnMount({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    actions.forEach((a) => dispatch(a));
  }, []);
  return <>{children}</>;
}
function Probe() {
  const { state } = useAetherStore();
  return <div data-testid="probe" data-tab={state.activeTab} data-notif-open={String(state.notifOpen)} />;
}
function renderStrip(actions: Action[] = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={[{ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' }, ...actions]}>
        <StandbyStrip />
        <Probe />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

const AGENT = { toolUseId: 'tu-1', subagentType: 'Explore', description: 'scan', startedAt: new Date().toISOString(), prompt: 'p', model: null };
const PROJECTS: ProjectsSnapshot = { roots: [{ key: 'r1' } as ProjectsSnapshot['roots'][number]], unscoped: null, computedAtMs: 0 };

describe('StandbyStrip', () => {
  it('lists each digest without data, then the memory count, as buttons', () => {
    renderStrip([{ type: 'SET_MEMORIES', memories: [{ id: 1 } as MemoryRow, { id: 2 } as MemoryRow] }]);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Agents 0', 'Projects 0', 'Alerts 0', 'Memory 2 engrams']);
    expect(screen.getByRole('heading', { level: 2, name: 'Standby' })).toBeTruthy();
  });

  it('drops the Agents item while an agent is running', () => {
    renderStrip([{ type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    expect(screen.queryByRole('button', { name: 'Agents 0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
  });

  it('is hidden when agents, projects and alerts all have data', () => {
    renderStrip([
      { type: 'SET_REAL_AGENTS', agents: [AGENT] },
      { type: 'SET_PROJECTS_SNAPSHOT', snapshot: PROJECTS },
      { type: 'SET_OP_MODE', mode: 'EDITS' }, // pushes a notif
    ]);
    expect(screen.queryByRole('heading', { name: 'Standby' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('navigates each item to its view, and Alerts opens the alerts dropdown', () => {
    renderStrip();
    const probe = () => screen.getByTestId('probe');
    fireEvent.click(screen.getByRole('button', { name: 'Agents 0' }));
    expect(probe().dataset.tab).toBe('Agents');
    fireEvent.click(screen.getByRole('button', { name: 'Projects 0' }));
    expect(probe().dataset.tab).toBe('Projects');
    fireEvent.click(screen.getByRole('button', { name: 'Memory 0 engrams' }));
    expect(probe().dataset.tab).toBe('Memory');
    fireEvent.click(screen.getByRole('button', { name: 'Alerts 0' }));
    expect(probe().dataset.notifOpen).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alerts 0' }));
    expect(probe().dataset.notifOpen).toBe('true'); // never toggles it shut
  });
});
