import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { useEffect, type ReactNode } from 'react';
import type { ControlStatus } from '../../shared/remote/types';

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
  delete (window as { aetherElectron?: unknown }).aetherElectron;
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

describe('Sidebar active item exposure', () => {
  it('marks only the active nav item with aria-current="page"', () => {
    renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Terminal' }]);
    const current = screen.getByTestId('sidebar-nav').querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('aria-current')).toBe('page');
    expect(current[0].textContent).toContain('Terminal');
  });
});

function mkStatus(patch: Partial<ControlStatus> = {}): ControlStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', connected: 1, devices: [], pairingActive: false, reenableAtLaunch: false, phoneTyping: true, notice: null, ...patch };
}
function installControl(initial: ControlStatus) {
  let push: (s: ControlStatus) => void = () => {};
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    control: { status: vi.fn().mockResolvedValue(initial), onStatus: (cb: (s: ControlStatus) => void) => { push = cb; return vi.fn(); } },
  };
  return (s: ControlStatus) => act(() => push(s));
}
const badges = () => Array.from(document.querySelectorAll('[data-testid^="phone-badge-"]')).map((e) => e.getAttribute('data-testid'));

describe('Sidebar phone marker', () => {
  it('marks only the attached slot', async () => {
    installControl(mkStatus({ phoneSlots: ['terminal2'] }));
    renderSidebar();
    await act(async () => {});
    expect(badges()).toEqual(['phone-badge-terminal2']);
    expect(screen.getByText('Terminal 2').closest('button')?.querySelector('[aria-label="Phone attached"]')).not.toBeNull();
  });
  it('marks two attached slots', async () => {
    installControl(mkStatus({ phoneSlots: ['claude', 'codex'] }));
    renderSidebar();
    await act(async () => {});
    expect(badges()).toEqual(['phone-badge-claude', 'phone-badge-codex']);
  });
  it('shows nothing for undefined, empty, or browser mode', async () => {
    renderSidebar();
    await act(async () => {});
    expect(badges()).toEqual([]);
    cleanup();
    installControl(mkStatus({ phoneSlots: undefined }));
    renderSidebar();
    await act(async () => {});
    expect(badges()).toEqual([]);
    cleanup();
    installControl(mkStatus({ phoneSlots: [] }));
    renderSidebar();
    await act(async () => {});
    expect(badges()).toEqual([]);
  });
  it('phone attach never moves the PC active tab; a later empty push removes the marker', async () => {
    const push = installControl(mkStatus({ phoneSlots: [] }));
    renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Terminal' }]);
    await act(async () => {});
    push(mkStatus({ phoneSlots: ['terminal2'] }));
    const current = screen.getByTestId('sidebar-nav').querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Terminal');
    expect(current[0].textContent).not.toContain('Terminal 2');
    expect(badges()).toEqual(['phone-badge-terminal2']);
    push(mkStatus({ phoneSlots: [] }));
    expect(badges()).toEqual([]);
  });
});
