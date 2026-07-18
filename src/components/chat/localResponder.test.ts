import { describe, expect, it } from 'vitest';
import { localResponder } from './localResponder';
import { AETHER_CHANNEL_ID, deriveChannels } from './chatChannels';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const channels = deriveChannels(initialState);
const aether = channels.find((c) => c.id === AETHER_CHANNEL_ID)!;
const codeBuilder = channels.find((c) => c.id === 'Code Builder')!;
const webScraper = channels.find((c) => c.id === 'Web Scraper')!; // archived (idle) channel

describe('localResponder — AETHER channel', () => {
  it('reports the live burn rate and active agent count', () => {
    const reply = localResponder(aether, "what's the burn rate?", initialState);
    expect(reply).toContain('92,000 tok/min');
    expect(reply).toContain('5 active agents');
  });

  it('reports remaining budget against the configured cap', () => {
    const reply = localResponder(aether, "how's our budget looking", initialState);
    expect(reply).toContain('2.0M cap');
  });

  it('reports a nominal reactor status with the pending approval count', () => {
    const reply = localResponder(aether, 'give me a status report', initialState);
    expect(reply).toContain('Reactor status: nominal');
    expect(reply).toContain('2 pending authorizations');
  });

  it('reports a critical reactor status when the alarm level is crit', () => {
    const critState: AetherState = { ...initialState, alarmLevel: 'crit' };
    const reply = localResponder(aether, 'status check', critState);
    expect(reply).toContain('Reactor status: critical');
  });

  it('lists the active roster by name', () => {
    const reply = localResponder(aether, "who's on the team right now", initialState);
    expect(reply).toContain('Code Builder');
    expect(reply).toContain('5 active');
  });

  it('reports an empty roster honestly instead of an empty list', () => {
    const empty: AetherState = { ...initialState, agents: [] };
    const reply = localResponder(aether, "who's active", empty);
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

describe('localResponder — per-agent channel', () => {
  it("reports the agent's own progress and ETA", () => {
    const reply = localResponder(codeBuilder, "how's it going", initialState);
    expect(reply).toContain('62% through "Refactoring auth middleware"');
    expect(reply).toContain('ETA 4m');
  });

  it("lists the agent's touched files", () => {
    const reply = localResponder(codeBuilder, 'what files have you touched', initialState);
    expect(reply).toContain('routes/auth.js');
    expect(reply).toContain('middleware/session.js');
  });

  it('reports no files touched yet when the file list is empty', () => {
    const freshAgent: AetherState = {
      ...initialState,
      agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, files: [] } : a)),
    };
    const reply = localResponder(codeBuilder, 'any files yet', freshAgent);
    expect(reply).toContain('No files touched yet');
  });

  it('describes the current task', () => {
    const reply = localResponder(codeBuilder, "what's your mission", initialState);
    expect(reply).toContain('Current task: "Refactoring auth middleware"');
  });

  it('reports still running when asked to pause but not yet paused', () => {
    const reply = localResponder(codeBuilder, 'can you hold for a sec', initialState);
    expect(reply).toContain('Still running');
  });

  it('reports paused status when the agent is paused', () => {
    const pausedState: AetherState = {
      ...initialState,
      agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, paused: true } : a)),
    };
    const reply = localResponder(codeBuilder, 'are you paused', pausedState);
    expect(reply).toContain("I'm paused");
  });

  it('greets in character with its own name and progress', () => {
    const reply = localResponder(codeBuilder, 'hello', initialState);
    expect(reply).toContain('Code Builder here');
  });

  it('reports offline for an archived (terminated) channel instead of guessing', () => {
    const reply = localResponder(webScraper, 'status?', initialState);
    expect(reply).toContain('Web Scraper is offline');
    expect(reply).toContain('archived');
  });
});
