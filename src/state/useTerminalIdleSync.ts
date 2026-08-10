import { useEffect } from 'react';
import { useAetherStore } from './store';

/** How long the embedded terminal's pty must produce no output before its
 *  sidebar tab is treated as idle -- see docs/superpowers/specs/
 *  2026-08-09-sidebar-idle-indicator-design.md §2 for why this is an
 *  activity-silence proxy rather than a literal "awaiting input" signal. */
export const IDLE_THRESHOLD_MS = 3000;

/** Mirrors useTerminalAliveSync.ts's subscribe-on-mount/unsubscribe-on-unmount
 *  shape, but derives state.terminalIdle from the pty:data stream instead of
 *  pty:alive/pty:exit. Registers its own independent onData listener
 *  alongside PtyTerminal.tsx's -- electron/preload.ts's ipcRenderer.on-based
 *  registration supports multiple concurrent listeners, so this never
 *  interferes with the terminal's own data-to-xterm wiring. */
export function useTerminalIdleSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const pty = window.aetherElectron?.pty;
    if (!pty) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timer = null;
      dispatch({ type: 'SET_TERMINAL_IDLE', idle: true });
    };

    const markActive = () => {
      dispatch({ type: 'SET_TERMINAL_IDLE', idle: false });
      if (timer) clearTimeout(timer);
      timer = setTimeout(markIdle, IDLE_THRESHOLD_MS);
    };

    const unsubscribeData = pty.onData(markActive);
    // On exit, only clear the pending timer -- do not force idle back to
    // false. A dead pty has nothing new to report; terminalAlive already
    // communicates liveness separately (see spec §4).
    const unsubscribeExit = pty.onExit(() => {
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
