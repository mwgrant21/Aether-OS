import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { OpenTerminalButton, type OpenTerminalVariant } from './OpenTerminalButton';
import { DESKTOP_APP_REASON } from './readinessMath';
import { colors } from '../../styles/tokens';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

function StartOnDashboard() {
  const { state, dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' });
  }, [dispatch]);
  return <div data-testid="active-tab">{state.activeTab}</div>;
}

function renderButton({ live, variant }: { live?: boolean; variant?: OpenTerminalVariant } = {}) {
  return render(
    <AetherStoreProvider>
      <StartOnDashboard />
      <OpenTerminalButton live={live} variant={variant} />
    </AetherStoreProvider>,
  );
}
const button = () => screen.getByRole('button', { name: 'OPEN TERMINAL' });

describe('OpenTerminalButton', () => {
  it('in browser mode is aria-disabled (not removed), says why beneath, and does not navigate', () => {
    renderButton();
    const btn = button();
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
    fireEvent.click(button());
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
    expect(screen.queryByText(DESKTOP_APP_REASON)).toBeNull();
  });

  it('glows at rest only while a session is live', () => {
    vi.stubGlobal('aetherElectron', {});
    const { unmount } = renderButton({ live: false });
    expect(button().style.boxShadow).toBe('');
    unmount();
    renderButton({ live: true });
    expect(button().style.boxShadow).not.toBe('');
  });

  it('defaults to the primary look: the cyan gradient', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton();
    expect(button().style.background).toContain('linear-gradient');
  });

  it('secondary: the inset Secondary treatment, same navigation, never a resting glow', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton({ variant: 'secondary', live: true });
    const btn = button();
    expect(btn.style.background).not.toContain('linear-gradient');
    expect(btn.style.padding).toBe('7px 12px');
    expect(btn.style.color).toBe(cssColor(colors.accentCyan));
    expect(btn.style.boxShadow).toBe('');
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
  });

  it('secondary shares the desktop-app check: aria-disabled, the reason beneath, no navigation', () => {
    renderButton({ variant: 'secondary' });
    const btn = button();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe(screen.getByText(DESKTOP_APP_REASON).id);
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Dashboard');
  });
});
