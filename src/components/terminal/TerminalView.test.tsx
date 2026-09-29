import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';

// xterm needs a real canvas; the header is what's under test.
vi.mock('./PtyTerminal', () => ({ PtyTerminal: () => null, focusClaudeTerminal: () => {} }));
import { TerminalView } from './TerminalView';
import { CrossCheckComposerProvider } from './CrossCheckComposer';

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderView() {
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <CrossCheckComposerProvider>
        <TerminalView />
      </CrossCheckComposerProvider>
    </AetherStoreProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('TerminalView header', () => {
  it('reads "standby" with a flat dot when no session is live, not "session active"', () => {
    renderView();
    expect(screen.getByTestId('terminal-session-status').textContent).toBe(':~$ standby');
    expect(screen.getByTestId('terminal-session-dot').style.boxShadow).toBe('');
  });

  it('reads "session active" with a lit dot once a session is live', () => {
    renderView();
    act(() =>
      dispatchRef!({
        type: 'SET_REAL_USAGE',
        snapshot: { ...initialState.realUsage, burnRatePerMin: 500, lastScanAt: new Date().toISOString() },
      }),
    );
    expect(screen.getByTestId('terminal-session-status').textContent).toBe(':~$ session active');
    expect(screen.getByTestId('terminal-session-dot').style.boxShadow).not.toBe('');
  });
});
