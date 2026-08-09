import { useEffect } from 'react';
import { useAetherStore } from './store';

/** Mirrors the embedded terminal's real pty liveness into AetherState
 *  (state.terminalAlive), same subscribe-on-mount/unsubscribe-on-unmount
 *  pattern as useLedgerSync/useProjectsSync. There is no mount-time pull
 *  here (unlike ledger/projects' `.current()`) -- terminalAlive starts true
 *  in initialState (the pty auto-starts at launch, per PtyTerminal.tsx's
 *  module-level getOrCreateHost) and this hook only ever has something to
 *  report once the pty actually exits during this session. */
export function useTerminalAliveSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const pty = window.aetherElectron?.pty;
    if (!pty) return;

    const unsubscribe = pty.onExit(() => {
      dispatch({ type: 'SET_TERMINAL_ALIVE', alive: false });
    });

    return unsubscribe;
  }, [dispatch]);
}
