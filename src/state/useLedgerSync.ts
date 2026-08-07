import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useLedgerSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const ledger = window.aetherElectron?.ledger;
    if (!ledger) return;
    return ledger.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_LEDGER', ledger: snapshot });
    });
  }, [dispatch]);
}
