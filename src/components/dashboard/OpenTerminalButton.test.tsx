import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { OpenTerminalButton } from './OpenTerminalButton';
import { DESKTOP_APP_REASON } from './readinessMath';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function StartOnDashboard() {
  const { state, dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' });
  }, [dispatch]);
  return <div data-testid="active-tab">{state.activeTab}</div>;
}

function renderButton(live = false) {
  return render(
    <AetherStoreProvider>
      <StartOnDashboard />
      <OpenTerminalButton live={live} />
    </AetherStoreProvider>,
  );
}

describe('OpenTerminalButton', () => {
  it('in browser mode is aria-disabled (not removed), says why beneath, and does not navigate', () => {
    renderButton();
    const btn = screen.getByRole('button', { name: 'OPEN TERMINAL' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    const reason = screen.getByText(DESKTOP_APP_REASON);
    expect(btn.getAttribute('aria-describedby')).toBe(reason.id);
    expect(reason.id).not.toBe('');
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Dashboard');
  });

  it('in the desktop app switches to the Terminal view and shows no reason', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'OPEN TERMINAL' }));
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
    expect(screen.queryByText(DESKTOP_APP_REASON)).toBeNull();
  });

  it('glows at rest only while a session is live', () => {
    vi.stubGlobal('aetherElectron', {});
    const { unmount } = renderButton(false);
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' }).style.boxShadow).toBe('');
    unmount();
    renderButton(true);
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' }).style.boxShadow).not.toBe('');
  });
});
