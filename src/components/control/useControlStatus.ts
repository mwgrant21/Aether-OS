import { useEffect, useState } from 'react';
import type { ControlStatus } from '../../shared/remote/types';

/** Live phone-control status from the main process; null in browser mode. Local state only. */
export function useControlStatus(): ControlStatus | null {
  const [status, setStatus] = useState<ControlStatus | null>(null);
  useEffect(() => {
    const control = window.aetherElectron?.control;
    if (!control) return;
    let live = true;
    let pushed = false;
    void control.status().then(s => { if (live && !pushed) setStatus(s); }).catch(() => {});
    const unsubscribe = control.onStatus(s => { pushed = true; if (live) setStatus(s); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return status;
}
