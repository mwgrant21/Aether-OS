import { useEffect } from 'react';
import { useAetherStore } from './store';

export function usePermissionRequestSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const permission = window.aetherElectron?.permission;
    if (!permission) return;
    return permission.onRequest((request) => {
      dispatch({ type: 'SET_PENDING_PERMISSION_REQUEST', request });
    });
  }, [dispatch]);
}
