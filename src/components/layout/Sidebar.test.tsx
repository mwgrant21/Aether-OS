import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { useEffect, type ReactNode } from 'react';

// Sidebar renders <Reactor>, which calls useReducedMotion() -> window.matchMedia.
// jsdom doesn't implement matchMedia, so stub it the same way useReducedMotion.test.ts does.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function DispatchOnMount({ actions, children }: { actions: Array<{ type: string; [k: string]: unknown }>; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions.forEach((a) => dispatch(a as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderSidebar(actions: Array<{ type: string; [k: string]: unknown }> = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={actions}>
        <Sidebar />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

describe('Sidebar idle indicator', () => {
  it('does not show an idle pulse on Terminal or Codex by default (neither idle)', () => {
    renderSidebar();
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
    expect(screen.getByText('Codex').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('shows an idle pulse on Terminal when terminalIdle=true, terminalAlive=true, and Terminal is not the active tab', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_TERMINAL_ALIVE', alive: true },
      { type: 'SET_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).not.toBeNull();
  });

  it('does not show an idle pulse on Terminal when it IS the active tab, even if idle', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Terminal' },
      { type: 'SET_TERMINAL_ALIVE', alive: true },
      { type: 'SET_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('shows an idle pulse on Codex independently of Terminal\'s idle state', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true },
      { type: 'SET_CODEX_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Codex').closest('button')?.querySelector('[data-idle-pulse="true"]')).not.toBeNull();
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('never shows an idle pulse on a sidebar item outside the Terminal/Codex scope', () => {
    renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Grid' }]);
    expect(screen.getByText('Dashboard').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('does not show an idle pulse on Terminal when idle=true but the pty is dead (terminalAlive=false)', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_TERMINAL_ALIVE', alive: true },
      { type: 'SET_TERMINAL_IDLE', idle: true },
      { type: 'SET_TERMINAL_ALIVE', alive: false },
    ]);
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('does not show an idle pulse on Codex when idle=true but the pty is dead (codexTerminalAlive=false)', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true },
      { type: 'SET_CODEX_TERMINAL_IDLE', idle: true },
      { type: 'SET_CODEX_TERMINAL_ALIVE', alive: false },
    ]);
    expect(screen.getByText('Codex').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });
});

describe('Sidebar reactor legend aria-live scoping', () => {
  it('puts aria-live only on the status-line element, never on the wrapper', () => {
    renderSidebar();
    const status = screen.getByTestId('sidebar-reactor-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // The wrapper is the status element's grandparent (status -> reactorMiniWrap's
    // direct child column -> reactorMiniWrap itself) -- walk up and confirm
    // nothing above the status line carries aria-live, so a burn-rate tick or
    // a Dashboard-tab visibility flip doesn't re-announce the whole block.
    let el: HTMLElement | null = status.parentElement;
    while (el) {
      expect(el.getAttribute('aria-live')).toBeNull();
      el = el.parentElement;
    }
  });

  it('swaps the mini reactor for a same-size placeholder while on Dashboard', () => {
    const { container } = renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' }]);
    // No canvas-bearing Reactor markup should mount in the sidebar while its
    // (invisible) copy is redundant with the Dashboard's own full-size one.
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('mounts the mini reactor again off the Dashboard tab', () => {
    const { container } = renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Agents' }]);
    expect(container.querySelector('canvas')).not.toBeNull();
  });
});
