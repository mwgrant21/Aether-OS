import { useEffect, useRef } from 'react';
import { useAetherStore } from './store';

/** Mounted once by App, never by Settings. Enabling conveys preference only. */
export function useCommunicationSync() {
  const { state, dispatch } = useAetherStore();
  const revision = useRef(0);
  const rollbackError = useRef(false);
  useEffect(() => {
    const api = window.aetherElectron?.communication;
    if (!api) {
      dispatch({ type: 'SET_COMMUNICATION_ERROR', error: 'Communication is available in the desktop app.' });
      return;
    }
    let active = true;
    const unsubscribe = api.onSnapshot(snapshot => {
      revision.current++;
      if (active) dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot });
    });
    const before = ++revision.current;
    void api.snapshot().then(snapshot => {
      if (active && revision.current === before) dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot });
    }).catch(() => {
      if (active && revision.current === before) dispatch({ type: 'SET_COMMUNICATION_ERROR', error: 'Could not read communication status.' });
    });
    return () => { active = false; unsubscribe(); };
  }, [dispatch]);

  useEffect(() => {
    const api = window.aetherElectron?.communication;
    if (!api) return;
    let active = true;
    revision.current++;
    if (!rollbackError.current) dispatch({ type: 'SET_COMMUNICATION_ERROR', error: null });
    rollbackError.current = false;
    void api.setEnabled(state.communicationCfg.enabled).then(async result => {
      if (!active) return;
      if (!result.ok) {
        dispatch({ type: 'SET_COMMUNICATION_ERROR', error: result.code });
        if (state.communicationCfg.enabled) {
          rollbackError.current = true;
          dispatch({ type: 'SET_COMMUNICATION_CFG', enabled: false });
        }
      }
      const before = ++revision.current;
      const snapshot = await api.snapshot();
      if (active && revision.current === before) dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot });
    }).catch(() => {
      if (active) dispatch({ type: 'SET_COMMUNICATION_ERROR', error: 'Could not synchronize communication preference.' });
    });
    return () => { active = false; };
  }, [state.communicationCfg.enabled, dispatch]);
}
