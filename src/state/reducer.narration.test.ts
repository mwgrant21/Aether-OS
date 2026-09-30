import { describe, it, expect } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';
import type { AetherState } from './types';

describe('SET_DISPATCH_NARRATION', () => {
  it('adds a narration and severity keyed by toolUseId', () => {
    const state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'Done. Four files touched.', severity: 2, subagentType: 'code-reviewer', final: true });
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'Done. Four files touched.', severity: 2 });
  });

  it('overwrites an existing narration for the same toolUseId', () => {
    let state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'first', severity: 1, subagentType: 'code-reviewer', final: true });
    state = reducer(state, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'second', severity: 4, subagentType: 'code-reviewer', final: true });
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'second', severity: 4 });
  });
});

// Stage 14 Task 5: the reducer also appends a narrationFeed.ts voice-pack
// line to state.narrationMessages for the four real event sources -- these
// tests cover that wiring, not narrationFeed.ts's own mapping logic (see
// narrationFeed.test.ts for that).
describe('narrationMessages wiring', () => {
  // The real IPC order on the periodic tick (electron/main.ts): the dispatch is
  // open in realAgents, then agents:narration, then agents:snapshot without it.
  // The onPostToolUse tick sends narration and no snapshot at all. So the Comms
  // line must be resolvable from the narration action itself (subagentType),
  // never from recentCompletedDispatches / dispatchChannels, which only fill
  // AFTER the snapshot.
  const openDispatch = { toolUseId: 'tu-1', subagentType: 'code-reviewer', description: 'x', startedAt: new Date().toISOString(), prompt: 'x', model: null };
  const withOpen = (): AetherState => reducer(initialState, { type: 'SET_REAL_AGENTS', agents: [openDispatch] });
  const narration = (narrationText: string, severity: number, final: boolean) =>
    ({ type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: narrationText, severity, subagentType: 'code-reviewer', final }) as const;

  it('real order: open, narration (final), snapshot without it -> exactly one Comms line', () => {
    let state = withOpen();
    state = reducer(state, narration('irrelevant here', 4, true));
    state = reducer(state, { type: 'SET_REAL_AGENTS', agents: [] });
    const messages = state.narrationMessages['dispatch:tu-1'];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('CINDER');
    expect(messages[0].text.startsWith("Oh. That's actually interesting.")).toBe(true);
  });

  it('onPostToolUse order: open, narration (final), no snapshot -> exactly one Comms line', () => {
    const state = reducer(withOpen(), narration('done', 1, true));
    expect(state.narrationMessages['dispatch:tu-1']).toHaveLength(1);
  });

  // Orchestrator ruling (Task 7 fix round 1): a stall line is for the roster
  // only; it must not show in Comms as a completion of work still running.
  it('a stall (final: false) in the same order adds zero Comms lines but updates dispatchNarrations', () => {
    const seeded = withOpen();
    let state = reducer(seeded, narration('stalled line', 4, false));
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'stalled line', severity: 4 });
    state = reducer(state, { type: 'SET_REAL_AGENTS', agents: [openDispatch] });
    expect(state.narrationMessages).toEqual(seeded.narrationMessages);
    expect(state.narrationBudgets).toEqual(seeded.narrationBudgets);
  });

  it('a stall, then its recovery, then the snapshot -> exactly one Comms line', () => {
    let state = reducer(withOpen(), narration('stalled line', 4, false));
    state = reducer(state, narration('Recovered.', 1, true));
    state = reducer(state, { type: 'SET_REAL_AGENTS', agents: [] });
    expect(state.narrationMessages['dispatch:tu-1']).toHaveLength(1);
    expect(state.dispatchNarrations['tu-1']).toEqual({ narration: 'Recovered.', severity: 1 });
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
