import { describe, it, expect } from 'vitest';
import { createInterruptionBudget, canVolunteer, spendBudget } from './interruptionBudget';

describe('interruption budget', () => {
  it('allows volunteering when nothing has been spent yet', () => {
    const state = createInterruptionBudget();
    expect(canVolunteer(state, 1000, 60_000)).toBe(true);
  });

  it('spending records the time and blocks a second volunteer inside the window', () => {
    let state = createInterruptionBudget();
    state = spendBudget(state, 1000);
    expect(canVolunteer(state, 1000 + 30_000, 60_000)).toBe(false);
  });

  it('allows volunteering again once the window has elapsed', () => {
    let state = createInterruptionBudget();
    state = spendBudget(state, 1000);
    expect(canVolunteer(state, 1000 + 60_001, 60_000)).toBe(true);
  });

  it('spendBudget does not mutate the input state (immutable, matches HeadlineThrottle-adjacent style)', () => {
    const state = createInterruptionBudget();
    const next = spendBudget(state, 1000);
    expect(state.lastVolunteeredAtMs).toBeNull();
    expect(next.lastVolunteeredAtMs).toBe(1000);
  });
});
