import { describe, expect, it } from 'vitest';
import { agentApprovals, agentStatusLabel, pickSelectedAgent, pickSelectedRealAgent } from './agentsMath';
import { initialState } from '../../state/initialState';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

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

describe('pickSelectedRealAgent', () => {
  const fixtures: RealAgentDispatch[] = [
    { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-21T10:00:00.000Z', prompt: 'do the first thing', model: null },
    { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-21T10:00:05.000Z', prompt: 'do the second thing', model: 'claude-haiku-4-5' },
  ];

  it('returns the dispatch matching the selected toolUseId when present', () => {
    const agent = pickSelectedRealAgent(fixtures, 'tu_2');
    expect(agent?.toolUseId).toBe('tu_2');
  });

  it('falls back to the first dispatch when selected is null', () => {
    const agent = pickSelectedRealAgent(fixtures, null);
    expect(agent?.toolUseId).toBe('tu_1');
  });

  it('falls back to the first dispatch when selected does not match any current dispatch', () => {
    const agent = pickSelectedRealAgent(fixtures, 'tu_unknown');
    expect(agent?.toolUseId).toBe('tu_1');
  });

  it('returns null when there are no real dispatches at all', () => {
    expect(pickSelectedRealAgent([], 'anything')).toBeNull();
  });
});
