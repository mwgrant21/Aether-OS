import { useEffect } from 'react';
import { useAetherStore } from '../../state/store';

export function useRealUsageSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const usage = window.aetherElectron?.usage;
    if (!usage) return;
    return usage.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_REAL_USAGE', snapshot });
    });
  }, [dispatch]);
}
