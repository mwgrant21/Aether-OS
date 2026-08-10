import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from './store';
import { useCodexTerminalAliveSync } from './useCodexTerminalAliveSync';

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function Probe() {
  useCodexTerminalAliveSync();
  const { state } = useAetherStore();
  return <div data-testid="alive">{String(state.codexTerminalAlive)}</div>;
}

function renderProbe() {
  render(
    <AetherStoreProvider>
      <Probe />
    </AetherStoreProvider>,
  );
}

/** Installs a fake codexPty bridge and hands back the registered callbacks so a
 *  test can fire codexPty:alive / codexPty:exit the way main.ts would. */
function installCodexPtyBridge() {
  const listeners: { alive: Array<() => void>; exit: Array<() => void> } = { alive: [], exit: [] };
  const unsubscribeAlive = vi.fn();
  const unsubscribeExit = vi.fn();
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    codexPty: {
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

describe('useCodexTerminalAliveSync', () => {
  it('starts offline -- no codex pty exists until one is actually spawned', () => {
    installCodexPtyBridge();
    renderProbe();
    expect(screen.getByTestId('alive').textContent).toBe('false');
  });

  it('flips codexTerminalAlive true on a codexPty:alive push', () => {
    const bridge = installCodexPtyBridge();
    renderProbe();

    bridge.fireAlive();

    expect(screen.getByTestId('alive').textContent).toBe('true');
  });

  it('flips codexTerminalAlive back to false on a codexPty:exit push', () => {
    const bridge = installCodexPtyBridge();
    renderProbe();

    bridge.fireAlive();
    bridge.fireExit();

    expect(screen.getByTestId('alive').textContent).toBe('false');
  });

  it('comes back online when a replacement codex pty announces itself', () => {
    const bridge = installCodexPtyBridge();
    renderProbe();

    bridge.fireAlive();
    bridge.fireExit();
    bridge.fireAlive(); // respawn

    expect(screen.getByTestId('alive').textContent).toBe('true');
  });

  it('unsubscribes from both channels on unmount', () => {
    const bridge = installCodexPtyBridge();
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
