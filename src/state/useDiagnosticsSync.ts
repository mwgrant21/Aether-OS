import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useDiagnosticsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const diagnostics = window.aetherElectron?.diagnostics;
    if (!diagnostics) return;
    return diagnostics.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_DIAGNOSTICS', diagnostics: snapshot });
    });
  }, [dispatch]);
}
