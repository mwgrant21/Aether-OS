import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from './store';
import { useTerminalAliveSync } from './useTerminalAliveSync';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function Probe() {
  useTerminalAliveSync();
  const { state } = useAetherStore();
  return <div data-testid="alive">{String(state.terminalAlive)}</div>;
}

function renderProbe() {
  render(
    <AetherStoreProvider>
      <Probe />
    </AetherStoreProvider>,
  );
}

/** Installs a fake pty bridge and hands back the registered callbacks so a
 *  test can fire pty:alive / pty:exit the way main.ts would. */
function installPtyBridge() {
  const listeners: { alive: Array<() => void>; exit: Array<() => void> } = { alive: [], exit: [] };
  const unsubscribeAlive = vi.fn();
  const unsubscribeExit = vi.fn();
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    pty: {
      onAlive: (cb: () => void) => { listeners.alive.push(cb); return unsubscribeAlive; },
      onExit: (cb: () => void) => { listeners.exit.push(cb); return unsubscribeExit; },
    },
  };
  return {
    listeners,
    unsubscribeAlive,
    unsubscribeExit,
    fireAlive: () => act(() => { listeners.alive.forEach((cb) => cb()); }),
    fireExit: () => act(() => { listeners.exit.forEach((cb) => cb()); }),
  };
}

describe('useTerminalAliveSync', () => {
  it('starts offline -- no pty exists until one is actually spawned', () => {
    installPtyBridge();
    renderProbe();
    expect(screen.getByTestId('alive').textContent).toBe('false');
  });

  it('flips terminalAlive true on a pty:alive push', () => {
    const bridge = installPtyBridge();
    renderProbe();

    bridge.fireAlive();

    expect(screen.getByTestId('alive').textContent).toBe('true');
  });

  it('flips terminalAlive back to false on a pty:exit push', () => {
    const bridge = installPtyBridge();
    renderProbe();

    bridge.fireAlive();
    bridge.fireExit();

    expect(screen.getByTestId('alive').textContent).toBe('false');
  });

  it('comes back online when a replacement pty announces itself', () => {
    const bridge = installPtyBridge();
    renderProbe();

    bridge.fireAlive();
    bridge.fireExit();
    bridge.fireAlive(); // respawn

    expect(screen.getByTestId('alive').textContent).toBe('true');
  });

  it('unsubscribes from both channels on unmount', () => {
    const bridge = installPtyBridge();
    renderProbe();

    cleanup();

    expect(bridge.unsubscribeAlive).toHaveBeenCalled();
    expect(bridge.unsubscribeExit).toHaveBeenCalled();
  });

  it('does nothing when there is no Electron bridge at all', () => {
    renderProbe();
    expect(screen.getByTestId('alive').textContent).toBe('false');
  });
});
