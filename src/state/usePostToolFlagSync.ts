import { useEffect } from 'react';
import { useAetherStore } from './store';

export function usePostToolFlagSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const postToolFlag = window.aetherElectron?.postToolFlag;
    if (!postToolFlag) return;
    return postToolFlag.onRequest((request) => {
      if (request && !('toolName' in request)) {
        dispatch({ type: 'CLEAR_PENDING_POST_TOOL_FLAG', requestId: request.requestId });
        return;
      }
      dispatch({ type: 'SET_PENDING_POST_TOOL_FLAG', request });
    });
  }, [dispatch]);
}
