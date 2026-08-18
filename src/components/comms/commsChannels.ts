import type { AetherState } from '../../state/types';
import { colors } from '../../styles/tokens';

export const AETHER_CHANNEL_ID = 'AETHER';

// Sentinel `transcriptSourceId` for the AETHER channel: it resolves to the
// pinned session, not a dispatch, and there is no toolUseId for "the whole
// session" to key off of. useTranscriptSource.ts resolves this sentinel by
// asking electron/transcriptReader.ts (via aetherElectron.transcript.sources)
// for the source of kind 'session'.
export const SESSION_TRANSCRIPT_SENTINEL = '__session__';

export interface CommsChannel {
  id: string;
  kind: 'aether' | 'dispatch';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
  toolUseId?: string;
  // The id useTranscriptSource.ts needs to resolve this channel's real
  // transcript: SESSION_TRANSCRIPT_SENTINEL for AETHER, the dispatch's
  // toolUseId for a dispatch channel.
  transcriptSourceId: string | null;
}

// The channel list is derived fresh from live state on every call, not
// tracked in a separate registry: one channel per real dispatch pooled into
// state.dispatchChannels, plus the always-present AETHER channel.
export function deriveChannels(state: AetherState): CommsChannel[] {
  const aether: CommsChannel = {
    id: AETHER_CHANNEL_ID,
    kind: 'aether',
    name: 'AETHER',
    initials: 'AE',
    hue: colors.accentCyanSoft,
    archived: false,
    transcriptSourceId: SESSION_TRANSCRIPT_SENTINEL,
  };

  const dispatchChannelEntries: CommsChannel[] = state.dispatchChannels.map((d) => ({
    id: `dispatch:${d.toolUseId}`,
    kind: 'dispatch',
    name: d.description || d.subagentType,
    initials: d.subagentType.slice(0, 2).toUpperCase(),
    hue: colors.accentCyanSoft,
    archived: false,
    toolUseId: d.toolUseId,
    transcriptSourceId: d.toolUseId,
  }));

  return [aether, ...dispatchChannelEntries];
}

export function findChannel(channels: CommsChannel[], id: string): CommsChannel | null {
  return channels.find((c) => c.id === id) ?? null;
}
