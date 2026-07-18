import { describe, expect, it } from 'vitest';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel } from './chatChannels';
import { initialState } from '../../state/initialState';
import { colors } from '../../styles/tokens';
import type { AetherState } from '../../state/types';

describe('deriveChannels', () => {
  it('always puts AETHER first, unarchived', () => {
    const channels = deriveChannels(initialState);
    expect(channels[0]).toMatchObject({ id: AETHER_CHANNEL_ID, kind: 'aether', archived: false });
  });

  it('adds one unarchived channel per active agent, in roster order', () => {
    const channels = deriveChannels(initialState);
    const agentChannels = channels.filter((c) => c.kind === 'agent' && !c.archived);
    expect(agentChannels.map((c) => c.id)).toEqual(initialState.agents.map((a) => a.name));
    expect(agentChannels.every((c) => c.hue !== colors.textMuted)).toBe(true);
  });

  it('adds one archived, muted-hue channel per idle agent', () => {
    const channels = deriveChannels(initialState);
    const archivedChannels = channels.filter((c) => c.archived);
    expect(archivedChannels.map((c) => c.id)).toEqual(initialState.idleList.map((i) => i.name));
    expect(archivedChannels.every((c) => c.hue === colors.textMuted)).toBe(true);
  });

  it('returns only AETHER when there are no active or idle agents', () => {
    const empty: AetherState = { ...initialState, agents: [], idleList: [] };
    expect(deriveChannels(empty)).toEqual([
      { id: AETHER_CHANNEL_ID, kind: 'aether', name: 'AETHER', initials: 'AE', hue: colors.accentCyanSoft, archived: false },
    ]);
  });
});

describe('findChannel', () => {
  it('finds a channel by id', () => {
    expect(findChannel(deriveChannels(initialState), 'Code Builder')?.name).toBe('Code Builder');
  });

  it('returns null for an unknown id', () => {
    expect(findChannel(deriveChannels(initialState), 'Nobody')).toBeNull();
  });
});
