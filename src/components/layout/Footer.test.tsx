import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Footer } from './Footer';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';
import { NO_DATA } from '../dashboard/dashboardMath';

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderFooter() {
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <Footer />
    </AetherStoreProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Footer status dot', () => {
  it('is flat at STANDBY', () => {
    renderFooter();
    expect(screen.getByText('STANDBY')).toBeTruthy();
    expect(screen.getByTestId('footer-status-dot').style.boxShadow).toBe('');
  });

  it('glows once a session is live (ALL GOOD)', () => {
    renderFooter();
    act(() =>
      dispatchRef!({
        type: 'SET_REAL_USAGE',
        snapshot: { ...initialState.realUsage, burnRatePerMin: 1234, lastScanAt: new Date().toISOString() },
      }),
    );
    expect(screen.getByText('ALL GOOD')).toBeTruthy();
    expect(screen.getByTestId('footer-status-dot').style.boxShadow).not.toBe('');
  });
});

describe('Footer uptime', () => {
  const uptimeText = () => screen.getByText(/^Uptime /).textContent;

  it('reads no-data before any terminal session has started', () => {
    renderFooter();
    expect(uptimeText()).toBe(`Uptime ${NO_DATA}`);
  });

  it('counts from the session start while the terminal is alive', () => {
    renderFooter();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(uptimeText()).toBe('Uptime 0h 0m');
  });

  it('goes back to no-data once the terminal session has exited', () => {
    renderFooter();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: false }));
    expect(uptimeText()).toBe(`Uptime ${NO_DATA}`);
  });
});
