import { describe, expect, it } from 'vitest';
import { pickSelectedRealAgent } from './agentsMath';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

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
