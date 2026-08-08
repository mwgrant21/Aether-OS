import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useProjectsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const projects = window.aetherElectron?.projects;
    if (!projects) return;

    // Pull what main already has before subscribing: the first scan can finish
    // before this listener exists, and the interval is 60s. Same race and same
    // fix as useLedgerSync.
    let cancelled = false;
    projects
      .current()
      .then((snapshot) => {
        if (!cancelled && snapshot) dispatch({ type: 'SET_PROJECTS_SNAPSHOT', snapshot });
      })
      .catch(() => {
        // Older main process without the pull channel; the push still works.
      });

    const unsubscribe = projects.onSnapshot((snapshot) => {
      cancelled = true;
      dispatch({ type: 'SET_PROJECTS_SNAPSHOT', snapshot });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [dispatch]);
}
