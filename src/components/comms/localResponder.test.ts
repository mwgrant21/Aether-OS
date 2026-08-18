import { describe, expect, it } from 'vitest';
import { localResponder } from './localResponder';
import { AETHER_CHANNEL_ID, deriveChannels } from './commsChannels';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

const channels = deriveChannels(initialState);
const aether = channels.find((c) => c.id === AETHER_CHANNEL_ID)!;

function makeDispatch(toolUseId: string, subagentType: string): RealAgentDispatch {
  return { toolUseId, subagentType, description: '', startedAt: new Date().toISOString(), prompt: '', model: null };
}

const withTwoAgents: AetherState = {
  ...initialState,
  realAgents: [makeDispatch('tu_1', 'Code Builder'), makeDispatch('tu_2', 'UI Designer')],
};

describe('localResponder — AETHER channel', () => {
  it('reports the live burn rate and active agent count', () => {
    const reply = localResponder(aether, "what's the burn rate?", withTwoAgents);
    expect(reply).toContain('92,000 tok/min');
    expect(reply).toContain('2 active agents');
  });

  it('reports remaining budget against the configured cap', () => {
    const reply = localResponder(aether, "how's our budget looking", initialState);
    expect(reply).toContain('2.0M cap');
  });

  it('reports a nominal reactor status with the pending approval count', () => {
    const reply = localResponder(aether, 'give me a status report', initialState);
    expect(reply).toContain('Reactor status: nominal');
    expect(reply).toContain('0 pending authorizations');
  });

  it('reports a critical reactor status when the alarm level is crit', () => {
    const critState: AetherState = { ...initialState, alarmLevel: 'crit' };
    const reply = localResponder(aether, 'status check', critState);
    expect(reply).toContain('Reactor status: critical');
  });

  it('lists the active roster by subagent type', () => {
    const reply = localResponder(aether, "who's on the team right now", withTwoAgents);
    expect(reply).toContain('Code Builder');
    expect(reply).toContain('2 active');
  });

  it('reports an empty roster honestly instead of an empty list', () => {
    const reply = localResponder(aether, "who's active", initialState);
    expect(reply).toContain('No agents are active');
  });

  it('greets in character', () => {
    const reply = localResponder(aether, 'hey', initialState);
    expect(reply).toContain('AETHER online');
  });

  it('falls back to an echo-and-hint reply for unrecognized input', () => {
    const reply = localResponder(aether, "what's your favorite color", initialState);
    expect(reply).toContain('favorite color');
    expect(reply.toLowerCase()).toContain('burn rate');
  });
});
