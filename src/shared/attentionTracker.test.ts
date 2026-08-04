import { describe, it, expect } from 'vitest';
import { createAttentionState, recordFocus, recordInteraction } from './attentionTracker';

describe('attention tracker', () => {
  it('starts with no focused panel and no interaction', () => {
    const state = createAttentionState();
    expect(state.focusedPanel).toBeNull();
    expect(state.lastInteractionAtMs).toBeNull();
  });

  it('recordFocus sets the focused panel without touching interaction time', () => {
    const state = recordFocus(createAttentionState(), 'agent-roster', 1000);
    expect(state.focusedPanel).toBe('agent-roster');
    expect(state.lastInteractionAtMs).toBeNull();
  });

  it('recordInteraction sets the interaction time without touching the focused panel', () => {
    const state = recordInteraction(recordFocus(createAttentionState(), 'agent-roster', 1000), 2000);
    expect(state.focusedPanel).toBe('agent-roster');
    expect(state.lastInteractionAtMs).toBe(2000);
  });

  it('does not mutate the input state', () => {
    const state = createAttentionState();
    const next = recordFocus(state, 'agent-roster', 1000);
    expect(state.focusedPanel).toBeNull();
    expect(next.focusedPanel).toBe('agent-roster');
  });
});
