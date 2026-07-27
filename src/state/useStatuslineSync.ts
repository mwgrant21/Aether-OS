import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useStatuslineSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const statusline = window.aetherElectron?.statusline;
    if (!statusline) return;

    // Pull whatever the watcher already captured (including from before this
    // renderer finished loading, or from a previous app run) once on mount --
    // the push-only 'statusline:snapshot' listener below only fires on the
    // *next* on-disk change, so without this a valid recent payload sitting on
    // disk would otherwise never reach the UI until something writes again.
    let cancelled = false;
    statusline.currentSnapshot().then((snapshot) => {
      if (!cancelled) dispatch({ type: 'SET_STATUSLINE', snapshot });
    });

    const unsubscribe = statusline.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_STATUSLINE', snapshot });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);
}
