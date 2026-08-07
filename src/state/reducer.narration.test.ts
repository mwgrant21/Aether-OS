import { describe, it, expect } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';
import type { AetherState } from './types';

describe('SET_DISPATCH_NARRATION', () => {
  it('adds a narration and severity keyed by toolUseId', () => {
    const state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'Done. Four files touched.', severity: 2 });
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'Done. Four files touched.', severity: 2 });
  });

  it('overwrites an existing narration for the same toolUseId', () => {
    let state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'first', severity: 1 });
    state = reducer(state, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'second', severity: 4 });
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'second', severity: 4 });
  });
});

// Stage 14 Task 5: the reducer also appends a narrationFeed.ts voice-pack
// line to state.narrationMessages for the four real event sources -- these
// tests cover that wiring, not narrationFeed.ts's own mapping logic (see
// narrationFeed.test.ts for that).
describe('narrationMessages wiring', () => {
  function withCompletedDispatch(toolUseId: string, subagentType: string): AetherState {
    return {
      ...initialState,
      recentCompletedDispatches: [
        { toolUseId, subagentType, description: 'x', startedAt: new Date().toISOString(), prompt: 'x', model: null },
      ],
    };
  }

  it('SET_DISPATCH_NARRATION appends a narrationFeed line to the dispatch channel when the dispatch is known', () => {
    const seeded = withCompletedDispatch('tu-1', 'code-reviewer');
    const state = reducer(seeded, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'irrelevant here', severity: 4 });
    const messages = state.narrationMessages['dispatch:tu-1'];
    expect(messages).toBeDefined();
    expect(messages[0].role).toBe('CINDER');
    expect(messages[0].text.startsWith("Oh. That's actually interesting.")).toBe(true);
  });

  it('SET_DISPATCH_NARRATION is a no-op for narrationMessages when the dispatch is unknown', () => {
    const state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-unknown', narration: 'x', severity: 4 });
    expect(state.narrationMessages).toEqual({});
  });

  it('SET_ANOMALIES appends a STEWARD line to AETHER for a newly detected anomaly', () => {
    const state = reducer(initialState, { type: 'SET_ANOMALIES', anomalies: [{ kind: 'stalledPermission', toolUseId: 'tu-2', detail: 'blocked' }] });
    const messages = state.narrationMessages['AETHER'];
    expect(messages).toBeDefined();
    expect(messages.some((m) => m.role === 'STEWARD')).toBe(true);
  });

  it('SET_ANOMALIES appends the all_clear line when the anomaly list empties out', () => {
    const withAnomaly = reducer(initialState, { type: 'SET_ANOMALIES', anomalies: [{ kind: 'reReadLoop', toolUseId: 'tu-3', detail: 'x' }] });
    const cleared = reducer(withAnomaly, { type: 'SET_ANOMALIES', anomalies: [] });
    const messages = cleared.narrationMessages['AETHER'];
    expect(messages.some((m) => m.text.startsWith('Nothing requires you.'))).toBe(true);
  });

  it('SET_PENDING_PERMISSION_REQUEST appends a STEWARD line when a request newly appears', () => {
    const state = reducer(initialState, {
      type: 'SET_PENDING_PERMISSION_REQUEST',
      request: { requestId: 'r1', toolName: 'Bash', toolInput: {}, risk: 'HIGH', editableField: null },
    });
    expect(state.narrationMessages['AETHER']).toBeDefined();
  });

  it('SET_PENDING_POST_TOOL_FLAG appends a STEWARD line when a flag newly appears', () => {
    const state = reducer(initialState, {
      type: 'SET_PENDING_POST_TOOL_FLAG',
      request: { requestId: 'r1', toolUseId: 'tu-4', toolName: 'Write', anomalyKind: 'writeDeleteRewrite', detail: 'x' },
    });
    expect(state.narrationMessages['AETHER']).toBeDefined();
  });
});
