import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react';
import { initialState } from './initialState';
import { reducer, type Action } from './reducer';
import type { AetherState } from './types';
import { loadPersisted, savePersisted } from './persistence';

interface StoreValue {
  state: AetherState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function AetherStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState, (init) => {
    const persisted = loadPersisted();
    if (!persisted) return init;
    // Merge cfg field-by-field rather than replacing it wholesale -- a
    // pre-branch persisted blob (e.g. an old `aetheros-v1` localStorage
    // entry) is missing newer Cfg fields like autoHeadlines/narrationVerbosity,
    // and `{ ...init, ...persisted }` alone lets persisted.cfg replace
    // init.cfg outright, leaving those fields undefined for existing users.
    return { ...init, ...persisted, cfg: { ...init.cfg, ...persisted.cfg } };
  });

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'TICK' }), 900);
    return () => clearInterval(id);
  }, []);

  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => savePersisted(state), 600);
    return () => clearTimeout(persistTimer.current);
  }, [state]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useAetherStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useAetherStore must be used within AetherStoreProvider');
  return ctx;
}
