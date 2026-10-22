import { useEffect, useState } from 'react';
import type { RemoteStatus } from '../../shared/remote/types';

/** Live remote-access status from the main process; null in browser mode. Local state only. */
export function useRemoteStatus(): RemoteStatus | null {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  useEffect(() => {
    const remote = window.aetherElectron?.remote;
    if (!remote) return;
    let live = true;
    let pushed = false;
    void remote.status().then(s => { if (live && !pushed) setStatus(s); }).catch(() => {});
    const unsubscribe = remote.onStatus(s => { pushed = true; if (live) setStatus(s); });
    return () => { live = false; unsubscribe(); };
  }, []);
  return status;
}
