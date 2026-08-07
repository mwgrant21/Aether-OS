import { useMemo, useState, type Dispatch } from 'react';
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
// is deliberately NOT `state.selected`/`SELECT_AGENT` (that's "which agent is
// selected" for Grid/Agents) — Chat's "which channel is open" is a different
// axis entirely and would be wrong to conflate just because both happen to
// name an agent. See Global Constraints.
//
// Stage 14 (Task 3): the send/typing/per-channel ChatMessage history this
// hook used to own is gone — the thread now renders real transcript messages
// via useTranscriptSource.ts, owned by CommsView's own useState per the
// render-not-store rule (see src/state/noPayloadInStore.test.ts). This hook
// keeps doing exactly what its name says: deriving and tracking channels.
// `unreadCounts` stays as an always-empty placeholder for narration's
// interruptionBudget-driven unread badges (design doc §B, out of scope for
// this task) so ChannelRail's existing prop contract doesn't need touching.
// The `dispatch` param is kept in the public signature for a future stage to
// build on, same as before.
export function useCommsChannels(state: AetherState, _dispatch: Dispatch<Action>): UseCommsChannelsResult {
  const channels = useMemo(() => deriveChannels(state), [state.agents, state.idleList, state.dispatchChannels]);
  const [activeChannelId, setActiveChannelId] = useState<string>(AETHER_CHANNEL_ID);
  const activeChannel = findChannel(channels, activeChannelId) ?? channels[0];

  return {
    channels,
    activeChannel,
    activeChannelId: activeChannel.id,
    setActiveChannelId,
    unreadCounts: {},
  };
}
