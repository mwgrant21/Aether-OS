import { useEffect } from 'react';
import { useAetherStore } from './store';

/** Mirrors the embedded terminal's real pty liveness into AetherState
 *  (state.terminalAlive), same subscribe-on-mount/unsubscribe-on-unmount
 *  pattern as useLedgerSync/useProjectsSync.
 *
 *  terminalAlive starts FALSE in initialState, because nothing starts a pty
 *  at launch: PtyTerminal.tsx's module-level getOrCreateHost() only runs when
 *  the Terminal tab is actually mounted, so a launch that restores a different
 *  persisted activeTab (or a renderer running outside Electron at all) never
 *  spawns one. Liveness is therefore driven entirely by the two push events
 *  main.ts sends: `pty:alive` when a pty is successfully spawned and wired,
 *  and `pty:exit` when the current one dies. There is no mount-time pull
 *  (unlike ledger/projects' `.current()`) -- main re-announces `pty:alive`
 *  on every `pty:start`. */
export function useTerminalAliveSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const pty = window.aetherElectron?.pty;
    if (!pty) return;

    const unsubscribeAlive = pty.onAlive(() => {
      dispatch({ type: 'SET_TERMINAL_ALIVE', alive: true });
    });
    const unsubscribeExit = pty.onExit(() => {
      dispatch({ type: 'SET_TERMINAL_ALIVE', alive: false });
    });

    return () => {
      unsubscribeAlive();
      unsubscribeExit();
    };
  }, [dispatch]);
}
