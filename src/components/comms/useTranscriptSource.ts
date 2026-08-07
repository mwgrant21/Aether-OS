// useTranscriptSource.ts (Stage 14, Task 3)
//
// RENDER-NOT-STORE RULE: transcript message content fetched here lives only
// in this hook's own useState, for as long as the mounted Comms view is
// mounted. It must never be merged into AetherState, never enter
// persistence.ts's savePersisted whitelist, never be written to
// ~/.aether-os/, and never reach the collector's SQLite store. See
// docs/privacy-and-data.md's "Rendering is not storing" paragraph and the
// mechanical check in src/state/noPayloadInStore.test.ts. `state` from
// useAetherStore() is consumed below ONLY for its identity (it changes on
// every 900ms TICK -- see store.tsx) so a live source's tail can be
// re-polled "on the app's existing tick"; its contents are never read here.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DisplayMessage, TranscriptSource } from '../../../electron/transcriptReader';
import { useAetherStore } from '../../state/store';
import { SESSION_TRANSCRIPT_SENTINEL } from './commsChannels';

export interface UseTranscriptSourceResult {
  messages: DisplayMessage[];
  isLive: boolean;
  loadOlder: () => Promise<void>;
  refresh: () => Promise<void>;
}

const TAIL_LIMIT = 200;
const LOAD_OLDER_LIMIT = 100;

// A channel's `transcriptSourceId` (SESSION_TRANSCRIPT_SENTINEL, or a
// dispatch's toolUseId) is a stable business key, not the raw id
// transcriptReader.ts's read/isLive machinery expects. Resolve it against
// the current source list: the pinned session for the sentinel, or the
// dispatch source whose meta-derived toolUseId matches.
function resolveSource(sourceId: string, sources: TranscriptSource[]): TranscriptSource | null {
  if (sourceId === SESSION_TRANSCRIPT_SENTINEL) {
    return sources.find((s) => s.kind === 'session') ?? null;
  }
  return sources.find((s) => s.kind === 'dispatch' && s.toolUseId === sourceId) ?? null;
}

export function useTranscriptSource(sourceId: string | null): UseTranscriptSourceResult {
  const { state } = useAetherStore();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isLive, setIsLive] = useState(false);
  const nextBeforeRef = useRef<string | null>(null);
  const resolvedIdRef = useRef<string | null>(null);

  const fetchTail = useCallback(async (id: string) => {
    const api = window.aetherElectron;
    if (!api) return;
    const sources = await api.transcript.sources();
    const resolved = resolveSource(id, sources);
    if (!resolved) {
      resolvedIdRef.current = null;
      setMessages([]);
      setIsLive(false);
      nextBeforeRef.current = null;
      return;
    }
    resolvedIdRef.current = resolved.id;
    setIsLive(resolved.isLive);
    const result = await api.transcript.read({ source: resolved.id, limit: TAIL_LIMIT });
    setMessages(result.messages);
    nextBeforeRef.current = result.nextBefore;
  }, []);

  // Fetch on mount and whenever the channel's source changes.
  useEffect(() => {
    if (!sourceId) {
      resolvedIdRef.current = null;
      setMessages([]);
      setIsLive(false);
      nextBeforeRef.current = null;
      return;
    }
    fetchTail(sourceId);
  }, [sourceId, fetchTail]);

  // Re-fetch the tail on the app's existing tick, but only while the source
  // is live -- a replay/ended source's content never changes underneath the
  // reader, so polling it would just be wasted IPC traffic.
  useEffect(() => {
    if (!sourceId || !isLive) return;
    fetchTail(sourceId);
    // Deliberately keyed on `state` (the app's 900ms TICK cadence, see
    // store.tsx) rather than a bespoke interval, per the design doc's "Does
    // the thread live-follow an active session?" decision -- reuse the
    // cadence the app already has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const loadOlder = useCallback(async () => {
    const api = window.aetherElectron;
    const resolvedId = resolvedIdRef.current;
    const before = nextBeforeRef.current;
    if (!api || !resolvedId || !before) return;
    const result = await api.transcript.read({ source: resolvedId, limit: LOAD_OLDER_LIMIT, before });
    setMessages((prev) => [...result.messages, ...prev]);
    nextBeforeRef.current = result.nextBefore;
  }, []);

  const refresh = useCallback(async () => {
    if (!sourceId) return;
    await fetchTail(sourceId);
  }, [sourceId, fetchTail]);

  return { messages, isLive, loadOlder, refresh };
}
