import { describe, expect, it } from 'vitest';
import { agentApprovals, agentStatusLabel, pickSelectedAgent } from './agentsMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedAgent', () => {
  it('returns the agent matching state.selected when present', () => {
    const agent = pickSelectedAgent(initialState.agents, 'Database Agent');
    expect(agent?.name).toBe('Database Agent');
  });

  it('falls back to the first agent when selected is null', () => {
    const agent = pickSelectedAgent(initialState.agents, null);
    expect(agent?.name).toBe(initialState.agents[0].name);
  });

  it('falls back to the first agent when selected no longer exists (e.g. just terminated)', () => {
    const agent = pickSelectedAgent(initialState.agents, 'Nonexistent Agent');
    expect(agent?.name).toBe(initialState.agents[0].name);
  });

  it('returns null when there are no agents at all', () => {
    expect(pickSelectedAgent([], 'Anything')).toBeNull();
  });
});

describe('agentApprovals', () => {
  it('filters the approval queue down to one agent', () => {
    const result = agentApprovals(initialState.approvals, 'Code Builder');
    expect(result).toHaveLength(1);
    expect(result[0].agent).toBe('Code Builder');
  });

  it('returns an empty array for an agent with no pending approvals', () => {
    expect(agentApprovals(initialState.approvals, 'Test Runner')).toEqual([]);
  });
});

describe('agentStatusLabel', () => {
  it('labels a paused agent PAUSED and an unpaused (or unset) agent ACTIVE', () => {
    expect(agentStatusLabel({ ...initialState.agents[0], paused: true })).toBe('PAUSED');
    expect(agentStatusLabel({ ...initialState.agents[0], paused: false })).toBe('ACTIVE');
    expect(agentStatusLabel(initialState.agents[0])).toBe('ACTIVE');
  });
});
