import { useEffect } from 'react';
import { useAetherStore } from './store';

/** Mirrors useTerminalAliveSync.ts exactly, for the independent Codex pty.
 *  codexTerminalAlive starts FALSE for the same reason terminalAlive does:
 *  nothing spawns the Codex pty until CodexTerminalView actually mounts, and
 *  liveness is driven entirely by main's codexPty:alive/codexPty:exit pushes
 *  -- no mount-time pull, main re-announces codexPty:alive on every
 *  codexPty:start. */
export function useCodexTerminalAliveSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const codexPty = window.aetherElectron?.codexPty;
    if (!codexPty) return;

    const unsubscribeAlive = codexPty.onAlive(() => {
      dispatch({ type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
    });
    const unsubscribeExit = codexPty.onExit(() => {
      dispatch({ type: 'SET_CODEX_TERMINAL_ALIVE', alive: false });
    });

    return () => {
      unsubscribeAlive();
      unsubscribeExit();
    };
  }, [dispatch]);
}
