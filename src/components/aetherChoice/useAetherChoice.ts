import { useCallback, useEffect, useRef, useState } from 'react';
import type { AetherChoiceState } from '../../shared/aetherChoice/ipc';

export type AetherChoiceStatus = 'loading' | 'unavailable' | 'ready';

export function useAetherChoice(): {
  status: AetherChoiceStatus;
  state: AetherChoiceState | null;
  refresh: () => Promise<void>;
} {
  const bridge = window.aetherElectron?.aetherChoice;
  const [status, setStatus] = useState<AetherChoiceStatus>(bridge ? 'loading' : 'unavailable');
  const [state, setState] = useState<AetherChoiceState | null>(null);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    const b = window.aetherElectron?.aetherChoice;
    if (!b) return;
    try {
      const next = await b.state();
      if (!live.current) return;
      setState(next);
      setStatus('ready');
    } catch {
      // A rejected pull is the host-off path: no handler is registered.
      if (!live.current) return;
      setState(null);
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    live.current = true;
    const b = window.aetherElectron?.aetherChoice;
    if (!b) return;
    void refresh();
    // The push payload is only a trigger to re-pull; it is never read.
    const unsubscribe = b.onHalted(() => { void refresh(); });
    return () => {
      live.current = false;
      unsubscribe();
    };
  }, [refresh]);

  return { status, state, refresh };
}
