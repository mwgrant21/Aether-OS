import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import type { MemoryRow } from '../../state/types';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import { colors } from '../../styles/tokens';
import { TopBar } from '../layout/TopBar';
import { NOTIF_TRIGGER_ATTR } from '../layout/useDropdownFocus';
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
    renderStrip([{ type: 'SET_TERMINAL_ALIVE', alive: true }, { type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    expect(screen.queryByRole('button', { name: 'Agents 0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
  });

  it('keeps the Agents item when agents are retained but the terminal is dead', () => {
    renderStrip([{ type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    expect(screen.getByRole('button', { name: 'Agents 0' })).toBeTruthy();
  });

  it('is hidden when agents, projects and alerts all have data', () => {
    renderStrip([
      { type: 'SET_TERMINAL_ALIVE', alive: true },
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
    const alerts = screen.getByRole('button', { name: 'Alerts 0' });
    expect(alerts.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(alerts);
    expect(probe().dataset.notifOpen).toBe('true');
    expect(alerts.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(alerts);
    expect(probe().dataset.notifOpen).toBe('false'); // a second click closes it
    expect(alerts.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Agents 0' }).getAttribute('aria-expanded')).toBeNull();
  });
});

// jsdom normalizes colours (hex -> rgb), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

describe('StandbyStrip counts', () => {
  it('draws 0 in Text Muted and a count above 0 in Soft Signal, memory included', () => {
    renderStrip([{ type: 'SET_MEMORIES', memories: [{ id: 1 } as MemoryRow, { id: 2 } as MemoryRow] }]);
    expect(screen.getByTestId('strip-count-agents').style.color).toBe(cssColor(colors.textMuted));
    expect(screen.getByTestId('strip-count-alerts').style.color).toBe(cssColor(colors.textMuted));
    expect(screen.getByTestId('strip-count-memory').style.color).toBe(cssColor(colors.accentCyanSoft));
  });

  it('draws a 0 memory count in Text Muted too', () => {
    renderStrip();
    expect(screen.getByTestId('strip-count-memory').style.color).toBe(cssColor(colors.textMuted));
  });
});

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderWithTopBar() {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={[{ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' }]}>
        <DispatchProbe />
        <TopBar />
        <StandbyStrip />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

describe('StandbyStrip Alerts and the notifications dropdown', () => {
  const bell = () => screen.getByRole('button', { name: /^Notifications/ });
  const stripAlerts = () => screen.getByRole('button', { name: 'Alerts 0' });
  const panel = () => document.getElementById(bell().getAttribute('aria-controls')!)!;

  it('marks the strip Alerts item as a notifications trigger', () => {
    renderWithTopBar();
    const marker = stripAlerts().closest<HTMLElement>(`[${NOTIF_TRIGGER_ATTR}]`)!;
    expect(marker).not.toBeNull();
    expect(marker.style.display).toBe('contents');
  });

  it('moves focus into the panel when opened from the strip, and back to the strip item on Escape', () => {
    renderWithTopBar();
    stripAlerts().focus();
    fireEvent.click(stripAlerts());
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(stripAlerts());
  });

  it('closes from the strip when the bell opened it (no close-then-reopen)', () => {
    renderWithTopBar();
    bell().focus();
    fireEvent.click(bell());
    fireEvent.pointerDown(stripAlerts());
    fireEvent.click(stripAlerts());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(stripAlerts().getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back to the bell when the opening strip item has gone', () => {
    renderWithTopBar();
    stripAlerts().focus();
    fireEvent.click(stripAlerts());
    act(() => dispatchRef!({ type: 'SET_OP_MODE', mode: 'EDITS' })); // pushes a notif: the Alerts item leaves the strip
    expect(screen.queryByRole('button', { name: 'Alerts 0' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });
});
