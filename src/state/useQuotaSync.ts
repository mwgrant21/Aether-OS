import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useQuotaSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const quota = window.aetherElectron?.quota;
    if (!quota) return;

    // Pull whatever main already has before subscribing. The scan that
    // produces the first snapshot can finish before this listener is
    // registered, and the interval is 60s -- same race, same fix, as the
    // ledger and statusline channels.
    let cancelled = false;
    quota
      .current()
      .then((snapshot) => {
        // A live push may already have landed while this promise was in
        // flight; that value is newer, so don't overwrite it.
        if (!cancelled && snapshot) dispatch({ type: 'SET_QUOTA_EFFICIENCY', quota: snapshot });
      })
      .catch(() => {
        // An older main process without the pull channel: the push still works.
      });

    const unsubscribe = quota.onEfficiency((snapshot) => {
      cancelled = true;
      dispatch({ type: 'SET_QUOTA_EFFICIENCY', quota: snapshot });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);
}
