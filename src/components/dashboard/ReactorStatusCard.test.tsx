import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactorStatusCard } from './ReactorStatusCard';
import { Footer } from '../layout/Footer';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';

// ReactorStatusCard renders <Reactor>, which calls useReducedMotion() -> window.matchMedia.
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

describe('ReactorStatusCard status announcement', () => {
  it('shows the status visibly but leaves the single live region to the Footer', () => {
    const { container } = render(
      <AetherStoreProvider>
        <ReactorStatusCard />
        <Footer />
      </AetherStoreProvider>,
    );
    expect(screen.getByTestId('reactor-status-label').textContent).toContain('STANDBY');
    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].closest('footer')).not.toBeNull();
  });
});

describe('ReactorStatusCard accessibility', () => {
  function renderCard() {
    return render(
      <AetherStoreProvider>
        <ReactorStatusCard />
      </AetherStoreProvider>,
    );
  }

  it('exposes the reactor as an image labelled with its status and rate', () => {
    renderCard();
    expect(screen.getByRole('img', { name: 'Reactor: STANDBY, no live rate' })).toBeTruthy();
  });

  it('keeps OPEN TERMINAL flat (no glow) at STANDBY rest', () => {
    renderCard();
    const btn = screen.getByRole('button', { name: /OPEN TERMINAL/ });
    expect(btn.style.boxShadow).toBe('');
  });
});

describe('ReactorStatusCard live state', () => {
  let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
  function DispatchProbe() {
    dispatchRef = useAetherStore().dispatch;
    return null;
  }
  function renderLive(burnRatePerMin: number) {
    const utils = render(
      <AetherStoreProvider>
        <DispatchProbe />
        <ReactorStatusCard />
      </AetherStoreProvider>,
    );
    act(() =>
      dispatchRef!({
        type: 'SET_REAL_USAGE',
        snapshot: {
          ...initialState.realUsage,
          burnRatePerMin,
          lastScanAt: new Date().toISOString(),
        },
      }),
    );
    return utils;
  }

  it('labels the live reactor NOMINAL with the burn rate in tokens per minute', () => {
    renderLive(1234);
    expect(screen.getByRole('img', { name: 'Reactor: NOMINAL, 1,234 tokens per minute' })).toBeTruthy();
  });

  it('gives OPEN TERMINAL its resting active glow while a session is live', () => {
    renderLive(1234);
    const btn = screen.getByRole('button', { name: 'OPEN TERMINAL' });
    expect(btn.style.boxShadow).not.toBe('');
  });

  it('keeps the status dot flat at STANDBY and lit when live', () => {
    const { unmount } = render(
      <AetherStoreProvider>
        <ReactorStatusCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByTestId('reactor-status-dot').style.boxShadow).toBe('');
    unmount();
    renderLive(1234);
    expect(screen.getByTestId('reactor-status-dot').style.boxShadow).not.toBe('');
  });
});
