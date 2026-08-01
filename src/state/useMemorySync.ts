import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useMemorySync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const memory = window.aetherElectron?.memory;
    if (!memory) return;
    const offSnapshot = memory.onSnapshot((rows) => dispatch({ type: 'SET_MEMORIES', memories: rows ?? [] }));
    const offTombstones = memory.onTombstones((rows) => dispatch({ type: 'SET_MEMORY_TOMBSTONES', tombstones: rows ?? [] }));
    return () => {
      offSnapshot();
      offTombstones();
    };
  }, [dispatch]);
}
