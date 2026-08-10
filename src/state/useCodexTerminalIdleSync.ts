import { useEffect } from 'react';
import { useAetherStore } from './store';
import { IDLE_THRESHOLD_MS } from './useTerminalIdleSync';

/** Mirrors useTerminalIdleSync.ts exactly, for the independent Codex pty. */
export function useCodexTerminalIdleSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const codexPty = window.aetherElectron?.codexPty;
    if (!codexPty) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timer = null;
      dispatch({ type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    };

    const markActive = () => {
      dispatch({ type: 'SET_CODEX_TERMINAL_IDLE', idle: false });
      if (timer) clearTimeout(timer);
      timer = setTimeout(markIdle, IDLE_THRESHOLD_MS);
    };

    const unsubscribeData = codexPty.onData(markActive);
    const unsubscribeExit = codexPty.onExit(() => {
      if (timer) clearTimeout(timer);
      timer = null;
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      if (timer) clearTimeout(timer);
    };
  }, [dispatch]);
}
