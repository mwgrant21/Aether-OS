import { describe, it, expect } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';

describe('SET_DISPATCH_NARRATION', () => {
  it('adds a narration keyed by toolUseId', () => {
    const state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'Done. Four files touched.' });
    expect(state.dispatchNarrations['tu-1']).toBe('Done. Four files touched.');
  });

  it('overwrites an existing narration for the same toolUseId', () => {
    let state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'first' });
    state = reducer(state, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'second' });
    expect(state.dispatchNarrations['tu-1']).toBe('second');
  });
});
