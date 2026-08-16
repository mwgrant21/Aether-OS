import { useEffect } from 'react';
import { useAetherStore } from './store';

// Pushes the current threshold to main on every mount (covers app restart,
// where main.ts always starts with its own default until told otherwise)
// and on every change -- same pattern OperatingModeCard.tsx already uses for
// autoHeadlines.
export function usePermissionAutoAllowSync() {
  const { state } = useAetherStore();
  const { permissionAutoAllow } = state.cfg;

  useEffect(() => {
    window.aetherElectron?.permission.setAutoAllow(permissionAutoAllow);
  }, [permissionAutoAllow]);
}
