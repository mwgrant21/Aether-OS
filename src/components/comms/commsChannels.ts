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
  kind: 'aether' | 'agent' | 'dispatch';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
  toolUseId?: string;
  // The id useTranscriptSource.ts needs to resolve this channel's real
  // transcript: SESSION_TRANSCRIPT_SENTINEL for AETHER, the dispatch's
  // toolUseId for a dispatch channel, or null for a channel with no backing
  // transcript at all -- both the fictional/simulated `state.agents` roster
  // (as opposed to `state.realAgents`, which holds real Claude Code dispatches)
  // and its archived (idleList) counterparts are simulation-only and were
  // never a real Claude session or dispatch, so they get null regardless of
  // archived state.
  transcriptSourceId: string | null;
}

function agentInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// The channel list is derived fresh from live state on every call, not
// tracked in a separate registry: a channel is active exactly while its
// agent is in `state.agents`, and becomes archived the instant that agent
// moves to `state.idleList` (kill/terminate) -- and back to active on
// reactivation. This also means the app's seed idle agents show up as
// pre-archived channels from first load, correctly, since "idle" already
// means "not currently active" regardless of *why*. Idle agents don't carry
// a `hue` (that data doesn't survive termination), so archived channels get a
// flat muted tone -- which also happens to be the "greyed out" look the
// design spec calls for.
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

  const activeChannels: CommsChannel[] = state.agents.map((a) => ({
    id: a.name,
    kind: 'agent',
    name: a.name,
    initials: a.i,
    hue: a.hue,
    archived: false,
    transcriptSourceId: null,
  }));

  const archivedChannels: CommsChannel[] = state.idleList.map((idle) => ({
    id: idle.name,
    kind: 'agent',
    name: idle.name,
    initials: agentInitials(idle.name),
    hue: colors.textMuted,
    archived: true,
    transcriptSourceId: null,
  }));

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

  return [aether, ...activeChannels, ...archivedChannels, ...dispatchChannelEntries];
}

export function findChannel(channels: CommsChannel[], id: string): CommsChannel | null {
  return channels.find((c) => c.id === id) ?? null;
}
