import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useLedgerSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const ledger = window.aetherElectron?.ledger;
    if (!ledger) return;

    // Pull whatever main already has before subscribing. The scan that
    // produces the first snapshot can finish before this listener is
    // registered, and the interval is 60s -- without this the Ledger reads
    // "no snapshot yet" for up to a minute after launch even though the data
    // exists. Same race, same fix, as the statusline channel.
    let cancelled = false;
    ledger
      .current()
      .then((snapshot) => {
        // A live push may already have landed while this promise was in
        // flight; that value is newer, so don't overwrite it with the cached
        // one. `cancelled` is set by cleanup, which also covers unmount.
        if (!cancelled && snapshot) dispatch({ type: 'SET_LEDGER', ledger: snapshot });
      })
      .catch(() => {
        // An older main process without the pull channel: the push still works.
      });

    const unsubscribe = ledger.onSnapshot((snapshot) => {
      cancelled = true;
      dispatch({ type: 'SET_LEDGER', ledger: snapshot });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);
}
