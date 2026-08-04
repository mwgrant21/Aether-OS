import { describe, it, expect } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';

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
