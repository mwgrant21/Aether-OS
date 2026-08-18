import { useEffect, useMemo, useState, type Dispatch } from 'react';
import type { AetherState } from '../../state/types';
import type { Action } from '../../state/reducer';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel, type CommsChannel } from './commsChannels';

export interface UseCommsChannelsResult {
  channels: CommsChannel[];
  activeChannel: CommsChannel;
  activeChannelId: string;
  setActiveChannelId: (id: string) => void;
  unreadCounts: Record<string, number>;
}

// Owns the one piece of view-local, non-AetherState state this plan
// establishes as its own concept: which chat channel is currently open. This
// is deliberately NOT `state.selectedRealAgent`/`SELECT_REAL_AGENT` (that's
// "which agent is selected" for Grid/Agents) — Chat's "which channel is open"
// is a different axis entirely and would be wrong to conflate just because
// both happen to name an agent. See Global Constraints.
//
// Stage 14 (Task 3): the send/typing/per-channel ChatMessage history this
// hook used to own is gone — the thread now renders real transcript messages
// via useTranscriptSource.ts, owned by CommsView's own useState per the
// render-not-store rule (see src/state/noPayloadInStore.test.ts). This hook
// keeps doing exactly what its name says: deriving and tracking channels.
//
// Stage 14 (Task 5): `unreadCounts` is no longer a placeholder. It now counts
// narrationFeed.ts's messages whose interruptionBudget ranking allowed them
// to interrupt (`NarrationMessage.interrupts`) in every channel other than
// the one currently open -- narration in the active channel is visible
// in-thread already, so it never counts as unread against itself.
// The `dispatch` param is kept in the public signature for a future stage to
// build on, same as before.
//
// Post-hoc fix (final review, finding 4): the count above was monotonically
// increasing -- switching away from a channel and back never cleared it,
// since there was no read marker. `lastSeenAtMs` below is that marker: the
// `atMs` of the newest interrupting narration message this channel had
// received as of the last time it became (or stayed) the active channel.
// Only interrupting messages newer than that marker count as unread.
//
// This marker is deliberately kept in this hook's own component useState,
// the same place `activeChannelId` already lives, rather than added to
// AetherState/the reducer. It is exactly as session-scoped and as
// derived-from-live-events as `activeChannelId` itself -- there was already
// no reducer action for "channel became active" to hang a marker update off
// of, and adding one just to satisfy the letter of "track it in the reducer"
// would mean growing AetherState for state that's read-marker bookkeeping,
// not fleet state. It stays out of persistence.ts's whitelist for the same
// reason narrationMessages/narrationBudgets are excluded there (session-
// scoped, see persistence.ts) -- it isn't even a candidate since it never
// enters AetherState in the first place.
export function useCommsChannels(state: AetherState, _dispatch: Dispatch<Action>): UseCommsChannelsResult {
  const channels = useMemo(() => deriveChannels(state), [state.dispatchChannels]);
  const [activeChannelId, setActiveChannelId] = useState<string>(AETHER_CHANNEL_ID);
  const activeChannel = findChannel(channels, activeChannelId) ?? channels[0];

  const [lastSeenAtMs, setLastSeenAtMs] = useState<Record<string, number>>({});

  // Whenever a channel is (or becomes) the active channel, advance its
  // read marker to the newest interrupting narration line it currently
  // holds -- covers both the "just switched to it" case and "stayed on it
  // while new narration streamed in" case, so returning to it later never
  // shows stale unread for lines already seen while it was open.
  useEffect(() => {
    const messages = state.narrationMessages[activeChannel.id];
    if (!messages || messages.length === 0) return;
    const newestInterruptAtMs = messages.reduce((max, m) => (m.interrupts && m.atMs > max ? m.atMs : max), 0);
    if (newestInterruptAtMs === 0) return;
    setLastSeenAtMs((prev) =>
      (prev[activeChannel.id] ?? 0) >= newestInterruptAtMs ? prev : { ...prev, [activeChannel.id]: newestInterruptAtMs }
    );
  }, [activeChannel.id, state.narrationMessages]);

  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [channelId, messages] of Object.entries(state.narrationMessages)) {
      if (channelId === activeChannel.id) continue;
      const seenAtMs = lastSeenAtMs[channelId] ?? 0;
      const interruptCount = messages.filter((m) => m.interrupts && m.atMs > seenAtMs).length;
      if (interruptCount > 0) counts[channelId] = interruptCount;
    }
    return counts;
  }, [state.narrationMessages, activeChannel.id, lastSeenAtMs]);

  return {
    channels,
    activeChannel,
    activeChannelId: activeChannel.id,
    setActiveChannelId,
    unreadCounts,
  };
}
