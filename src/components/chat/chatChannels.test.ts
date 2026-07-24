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

  it('includes one dispatch-kind channel per state.dispatchChannels entry', () => {
    const withDispatch: AetherState = {
      ...initialState,
      dispatchChannels: [
        {
          toolUseId: 'tu_1',
          subagentType: 'general-purpose',
          description: 'Explore the repo',
          prompt: '',
          model: null,
          startedAt: '2026-07-20T10:00:00.000Z',
          createdAt: '10:00:00',
        },
      ],
    };
    const channels = deriveChannels(withDispatch);
    const dispatchChannel = channels.find((c) => c.kind === 'dispatch');
    expect(dispatchChannel).toMatchObject({ id: 'dispatch:tu_1', name: 'Explore the repo', archived: false, toolUseId: 'tu_1' });
  });

  it('falls back to subagentType for a dispatch channel name when description is empty', () => {
    const withDispatch: AetherState = {
      ...initialState,
      dispatchChannels: [
        { toolUseId: 'tu_2', subagentType: 'Explore', description: '', prompt: '', model: null, startedAt: '2026-07-20T10:00:00.000Z', createdAt: '10:00:00' },
      ],
    };
    const channels = deriveChannels(withDispatch);
    expect(channels.find((c) => c.kind === 'dispatch')?.name).toBe('Explore');
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
