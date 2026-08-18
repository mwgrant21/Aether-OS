import { describe, expect, it } from 'vitest';
import { AETHER_CHANNEL_ID, SESSION_TRANSCRIPT_SENTINEL, deriveChannels, findChannel } from './commsChannels';
import { initialState } from '../../state/initialState';
import { colors } from '../../styles/tokens';
import type { AetherState } from '../../state/types';

describe('deriveChannels', () => {
  it('always puts AETHER first, unarchived', () => {
    const channels = deriveChannels(initialState);
    expect(channels[0]).toMatchObject({ id: AETHER_CHANNEL_ID, kind: 'aether', archived: false });
  });

  it('returns only AETHER when there are no dispatch channels', () => {
    const empty: AetherState = { ...initialState, dispatchChannels: [] };
    expect(deriveChannels(empty)).toEqual([
      {
        id: AETHER_CHANNEL_ID,
        kind: 'aether',
        name: 'AETHER',
        initials: 'AE',
        hue: colors.accentCyanSoft,
        archived: false,
        transcriptSourceId: SESSION_TRANSCRIPT_SENTINEL,
      },
    ]);
  });

  it('gives dispatch channels their toolUseId as transcriptSourceId', () => {
    const withDispatch: AetherState = {
      ...initialState,
      dispatchChannels: [
        { toolUseId: 'tu_3', subagentType: 'general-purpose', description: 'Explore', prompt: '', model: null, startedAt: '2026-07-20T10:00:00.000Z', createdAt: '10:00:00' },
      ],
    };
    const channels = deriveChannels(withDispatch);
    expect(channels.find((c) => c.id === AETHER_CHANNEL_ID)?.transcriptSourceId).toBe(SESSION_TRANSCRIPT_SENTINEL);
    expect(channels.find((c) => c.kind === 'dispatch')?.transcriptSourceId).toBe('tu_3');
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
    expect(findChannel(deriveChannels(initialState), AETHER_CHANNEL_ID)?.name).toBe('AETHER');
  });

  it('returns null for an unknown id', () => {
    expect(findChannel(deriveChannels(initialState), 'Nobody')).toBeNull();
  });
});
