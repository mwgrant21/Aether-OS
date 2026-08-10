import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalIdleSync } from './useTerminalIdleSync';
import { AetherStoreProvider, useAetherStore } from './store';
import type { ReactNode } from 'react';

const IDLE_THRESHOLD_MS = 3000;

function wrapper({ children }: { children: ReactNode }) {
  return <AetherStoreProvider>{children}</AetherStoreProvider>;
}

describe('useTerminalIdleSync', () => {
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dataCallback = undefined;
    exitCallback = undefined;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      pty: {
        onData: (cb: (data: string) => void) => {
          dataCallback = cb;
          return () => { dataCallback = undefined; };
        },
        onExit: (cb: () => void) => {
          exitCallback = cb;
          return () => { exitCallback = undefined; };
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
  });

  it('does nothing when window.aetherElectron.pty is absent', () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {};
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );
    expect(result.current).toBe(false);
  });

  it('marks terminalIdle=true after IDLE_THRESHOLD_MS of no data', () => {
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );
    expect(result.current).toBe(false);

    act(() => {
      dataCallback?.('some output');
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });

    expect(result.current).toBe(true);
  });

  it('resets to terminalIdle=false when new data arrives, then re-idles after another silent window', () => {
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );

    act(() => {
      dataCallback?.('burst 1');
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });
    expect(result.current).toBe(true);

    act(() => {
      dataCallback?.('burst 2');
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });
    expect(result.current).toBe(true);
  });

  it('does not throw when the pty exits mid-countdown', () => {
    renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );

    expect(() => {
      act(() => {
        dataCallback?.('some output');
        exitCallback?.();
        vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
      });
    }).not.toThrow();
  });
});
