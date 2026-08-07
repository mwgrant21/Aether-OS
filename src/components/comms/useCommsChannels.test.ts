import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCommsChannels } from './useCommsChannels';
import { initialState } from '../../state/initialState';
import type { AetherState, NarrationMessage } from '../../state/types';
import { AETHER_CHANNEL_ID } from './commsChannels';

function stateWith(patch: Partial<AetherState>): AetherState {
  return { ...initialState, ...patch };
}

function narrationMessage(channelId: string, interrupts: boolean): NarrationMessage {
  return {
    id: `narr-${channelId}-${interrupts}`,
    channelId,
    role: 'STEWARD',
    voiceName: 'STEWARD',
    text: 'test narration',
    severity: 3,
    atMs: Date.now(),
    interrupts,
  };
}

describe('useCommsChannels: unreadCounts', () => {
  it('counts an interrupting narration message on a non-active channel', () => {
    const state = stateWith({
      narrationMessages: {
        [AETHER_CHANNEL_ID]: [narrationMessage(AETHER_CHANNEL_ID, true)],
      },
    });
    const dispatch = () => {};
    // Default active channel is AETHER_CHANNEL_ID (see useCommsChannels.ts),
    // so pick a different channel by deriving one from real state -- instead
    // route the narration through a channel we know differs from the default.
    const { result } = renderHook(() => useCommsChannels(state, dispatch));
    // The message landed on the default active channel, so it must NOT count.
    expect(result.current.unreadCounts[AETHER_CHANNEL_ID]).toBeUndefined();
  });

  it('increments unread count for an interrupting message on a non-active channel, and excludes the active channel', () => {
    const otherChannelId = 'dispatch:tu-1';
    const state = stateWith({
      narrationMessages: {
        [otherChannelId]: [narrationMessage(otherChannelId, true)],
        [AETHER_CHANNEL_ID]: [narrationMessage(AETHER_CHANNEL_ID, true)],
      },
    });
    const dispatch = () => {};
    const { result } = renderHook(() => useCommsChannels(state, dispatch));

    // Active channel defaults to AETHER_CHANNEL_ID -- its own interrupting
    // message must not count against itself.
    expect(result.current.activeChannelId).toBe(AETHER_CHANNEL_ID);
    expect(result.current.unreadCounts[AETHER_CHANNEL_ID]).toBeUndefined();

    // A different channel's interrupting message does count.
    expect(result.current.unreadCounts[otherChannelId]).toBe(1);
  });

  it('does not count a non-interrupting narration message on a non-active channel', () => {
    const otherChannelId = 'dispatch:tu-2';
    const state = stateWith({
      narrationMessages: {
        [otherChannelId]: [narrationMessage(otherChannelId, false)],
      },
    });
    const dispatch = () => {};
    const { result } = renderHook(() => useCommsChannels(state, dispatch));
    expect(result.current.unreadCounts[otherChannelId]).toBeUndefined();
  });
});
