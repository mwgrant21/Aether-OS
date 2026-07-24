import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useRealAgentsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onSnapshot((dispatches) => {
      dispatch({ type: 'SET_REAL_AGENTS', agents: dispatches });
    });
  }, [dispatch]);

  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onCompleted((completed) => {
      dispatch({ type: 'RECORD_DISPATCH_USAGE', completed });
    });
  }, [dispatch]);
}
