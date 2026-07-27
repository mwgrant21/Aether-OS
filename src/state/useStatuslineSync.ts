import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useStatuslineSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const statusline = window.aetherElectron?.statusline;
    if (!statusline) return;
    return statusline.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_STATUSLINE', snapshot });
    });
  }, [dispatch]);
}
