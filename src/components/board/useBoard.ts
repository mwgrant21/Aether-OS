import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardFeed, BoardSessionRef, BoardSessionSummary } from '../../shared/board/types';

// Rendering is not storing: everything fetched here lives in this hook's own React state and dies with
// the view. Pull-only (mount, select, Refresh); no timer and no store subscription.
function newestWithAgents(list: BoardSessionSummary[]): BoardSessionSummary | null {
  let best: BoardSessionSummary | null = null;
  for (const s of list) if (s.subagentCount > 0 && (!best || s.lastActiveMs > best.lastActiveMs)) best = s;
  return best; // none with agents: select nothing (agentless rows are hidden by default)
}

export function useBoard() {
  const api = typeof window === 'undefined' ? undefined : window.aetherElectron?.board;
  const [sessions, setSessions] = useState<BoardSessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BoardSessionRef | null>(null);
  const [feed, setFeed] = useState<BoardFeed | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const feedSeq = useRef(0);
  const sessionsSeq = useRef(0);
  const selectedRef = useRef<BoardSessionRef | null>(null);

  const loadFeed = useCallback(async (ref: BoardSessionRef) => {
    if (!api) return;
    const my = ++feedSeq.current;
    setLoading(true);
    try {
      const r = await api.feed(ref);
      if (my !== feedSeq.current) return;
      if (r.ok) { setFeed(r.feed); setFeedError(null); } else { setFeed(null); setFeedError(r.error); }
    } catch {
      if (my === feedSeq.current) { setFeed(null); setFeedError('Could not load this session.'); }
    } finally {
      if (my === feedSeq.current) setLoading(false);
    }
  }, [api]);

  const select = useCallback((ref: BoardSessionRef) => {
    selectedRef.current = ref;
    setSelected(ref);
    setFeed(null);
    setFeedError(null);
    void loadFeed(ref);
  }, [loadFeed]);

  const loadSessions = useCallback(async () => {
    if (!api) return;
    const my = ++sessionsSeq.current;
    try {
      const list = await api.sessions();
      if (my !== sessionsSeq.current) return;
      setSessions(list);
      setSessionsError(null);
      if (!selectedRef.current) {
        const pick = newestWithAgents(list);
        if (pick) select({ projectDir: pick.projectDir, sessionId: pick.sessionId });
      }
    } catch {
      if (my === sessionsSeq.current) { setSessions([]); setSessionsError('Could not list sessions.'); }
    }
  }, [api, select]);

  const clearSelection = useCallback(() => {
    selectedRef.current = null;
    feedSeq.current++; // drop any in-flight feed for the session being cleared
    setSelected(null);
    setFeed(null);
    setFeedError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(() => {
    void loadSessions();
    if (selectedRef.current) void loadFeed(selectedRef.current);
  }, [loadSessions, loadFeed]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  return { api, sessions, sessionsError, selected, select, clearSelection, feed, feedError, loading, refresh };
}
