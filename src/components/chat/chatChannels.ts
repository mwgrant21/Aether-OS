import type { AetherState } from '../../state/types';
import { colors } from '../../styles/tokens';

export const AETHER_CHANNEL_ID = 'AETHER';

export interface ChatChannel {
  id: string;
  kind: 'aether' | 'agent';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
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
export function deriveChannels(state: AetherState): ChatChannel[] {
  const aether: ChatChannel = {
    id: AETHER_CHANNEL_ID,
    kind: 'aether',
    name: 'AETHER',
    initials: 'AE',
    hue: colors.accentCyanSoft,
    archived: false,
  };

  const activeChannels: ChatChannel[] = state.agents.map((a) => ({
    id: a.name,
    kind: 'agent',
    name: a.name,
    initials: a.i,
    hue: a.hue,
    archived: false,
  }));

  const archivedChannels: ChatChannel[] = state.idleList.map((idle) => ({
    id: idle.name,
    kind: 'agent',
    name: idle.name,
    initials: agentInitials(idle.name),
    hue: colors.textMuted,
    archived: true,
  }));

  return [aether, ...activeChannels, ...archivedChannels];
}

export function findChannel(channels: ChatChannel[], id: string): ChatChannel | null {
  return channels.find((c) => c.id === id) ?? null;
}
