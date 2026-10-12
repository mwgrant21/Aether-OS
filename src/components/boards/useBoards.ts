import { useCallback, useEffect, useState } from 'react';
import type { BoardsListing } from '../../shared/dashboards/types';

/** Pull-based, view-local (like useTranscriptSource): board rows never enter the store. */
export function useBoards() {
  const api = window.aetherElectron?.dashboards;
  const [listing, setListing] = useState<BoardsListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changed, setChanged] = useState<{ ids: string[]; n: number }>({ ids: [], n: 0 });
  const reload = useCallback(() => {
    void api?.list().then(
      (l) => { setListing(l); setLoadError(null); },
      () => setLoadError('Could not load boards.'),
    );
  }, [api]);
  useEffect(() => {
    reload();
    if (!api) return undefined;
    return api.onChanged((ids) => { reload(); setChanged((c) => ({ ids, n: c.n + 1 })); });
  }, [api, reload]);
  return { api, listing, loadError, changed, reload };
}
