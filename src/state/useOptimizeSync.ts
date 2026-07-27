import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useOptimizeSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const optimize = window.aetherElectron?.optimize;
    if (!optimize) return;
    return optimize.onFindings((findings) => {
      dispatch({ type: 'SET_OPTIMIZE_FINDINGS', findings });
    });
  }, [dispatch]);

  useEffect(() => {
    const optimize = window.aetherElectron?.optimize;
    if (!optimize) return;
    return optimize.onSummary((summary) => {
      dispatch({ type: 'SET_OPTIMIZE_SUMMARY', summary });
    });
  }, [dispatch]);

  useEffect(() => {
    const optimize = window.aetherElectron?.optimize;
    if (!optimize) return;
    return optimize.onBreakdown((rows) => {
      dispatch({ type: 'SET_OPTIMIZE_BREAKDOWN', rows });
    });
  }, [dispatch]);
}
