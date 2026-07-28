import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useFleetSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const fleet = window.aetherElectron?.fleet;
    if (!fleet) return;
    return fleet.onSnapshot((rows) => {
      dispatch({ type: 'SET_FLEET', fleet: rows });
    });
  }, [dispatch]);
}
