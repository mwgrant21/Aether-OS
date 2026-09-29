import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Footer } from './Footer';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';

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
