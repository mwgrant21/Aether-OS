import { describe, expect, it } from 'vitest';
import { buildAetherSnapshot, buildAgentSnapshot, buildSystemPrompt } from './systemPrompt';
import { deriveChannels, AETHER_CHANNEL_ID } from './chatChannels';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const channels = deriveChannels(initialState);
const aether = channels.find((c) => c.id === AETHER_CHANNEL_ID)!;
const codeBuilder = channels.find((c) => c.id === 'Code Builder')!;
const webScraper = channels.find((c) => c.id === 'Web Scraper')!; // archived

describe('buildAetherSnapshot', () => {
  it('reports full fleet detail', () => {
    const snap = buildAetherSnapshot(initialState);
    expect(snap.burnRateTokPerMin).toBe(92000);
    expect(snap.budget).toEqual({ usedTokens: 24391, capTokens: 2_000_000 });
    expect(snap.alarmLevel).toBe('ok');
    expect(snap.agents).toHaveLength(5);
    expect(snap.agents[0]).toEqual({ name: 'Code Builder', role: 'Refactoring auth middleware', status: 'active', tokenDraw: Math.round(0.22 * 92000) });
    expect(snap.projects.map((p) => p.name)).toContain('CLI Companion');
    expect(snap.pendingApprovals).toHaveLength(2);
  });

  it('marks a paused agent status correctly', () => {
    const paused: AetherState = { ...initialState, agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, paused: true } : a)) };
    const snap = buildAetherSnapshot(paused);
    expect(snap.agents.find((a) => a.name === 'Code Builder')?.status).toBe('paused');
  });

  it('caps recentEvents at the last 5 log entries', () => {
    const withLogs: AetherState = { ...initialState, logs: Array.from({ length: 8 }, (_, i) => ({ t: `t${i}`, m: `m${i}`, c: '#fff' })) };
    const snap = buildAetherSnapshot(withLogs);
    expect(snap.recentEvents).toHaveLength(5);
    expect(snap.recentEvents[4].message).toBe('m7');
  });
});

describe('buildAgentSnapshot', () => {
  it("reports only that agent's own work, plus a light fleet summary", () => {
    const agent = initialState.agents.find((a) => a.name === 'Code Builder')!;
    const snap = buildAgentSnapshot(initialState, agent);
    expect(snap.self).toEqual({
      name: 'Code Builder',
      task: 'Refactoring auth middleware',
      pctComplete: 62,
      eta: '4m',
      paused: false,
      filesTouched: ['routes/auth.js', 'middleware/session.js'],
    });
    expect(snap.fleet).toEqual({ activeAgentCount: 5, burnRateTokPerMin: 92000, alarmLevel: 'ok' });
  });
});

describe('buildSystemPrompt', () => {
  it('AETHER prompt addresses the user as Operator and includes the full snapshot + Rules', () => {
    const prompt = buildSystemPrompt(aether, initialState);
    expect(prompt).toContain('Operator');
    expect(prompt).toContain('"burnRateTokPerMin":92000');
    expect(prompt).toContain('3 sentences');
    expect(prompt).not.toContain('markdown');  // guard against accidentally instructing markdown ON
  });

  it("agent-channel prompt uses that agent's persona and does not leak other agents' names", () => {
    const prompt = buildSystemPrompt(codeBuilder, initialState);
    expect(prompt.toLowerCase()).toContain('terse');
    expect(prompt).toContain('Refactoring auth middleware');
    expect(prompt).not.toContain('UI Designer');
    expect(prompt).not.toContain('Database Agent');
    expect(prompt).not.toContain('pendingApprovals');
  });

  it('falls back to FALLBACK_PERSONA voice for a custom-spawned agent name', () => {
    const custom = { ...codeBuilder, id: 'My Custom Agent', name: 'My Custom Agent' };
    const withCustom: AetherState = { ...initialState, agents: [...initialState.agents, { ...initialState.agents[0], name: 'My Custom Agent' }] };
    const prompt = buildSystemPrompt(custom, withCustom);
    expect(prompt.toLowerCase()).toContain('no-nonsense');
  });

  it('builds a safe, non-crashing prompt for an archived channel', () => {
    const prompt = buildSystemPrompt(webScraper, initialState);
    expect(prompt).toContain('Web Scraper');
    expect(prompt.toLowerCase()).toContain('offline');
  });

  it('mentions the action-JSON convention (Phase 2b will parse it; this prompt only documents it)', () => {
    const prompt = buildSystemPrompt(aether, initialState);
    expect(prompt).toContain('"verb"');
    expect(prompt).toContain('spawn');
  });

  it('spells out the exact args key for every verb, not a generic {...} placeholder (regression: live-model QA found the model substituting "color" for theme\'s required "name" when the shape was unspecified)', () => {
    const prompt = buildSystemPrompt(aether, initialState);
    expect(prompt).toContain('{"verb":"theme","args":{"name":"cyan|blue|teal|violet|amber|red"}}');
    expect(prompt).toContain('{"verb":"renderer","args":{"mode":"nebula|volumetric|warp"}}');
    expect(prompt).toContain('{"verb":"spawn|kill|throttle","args":{"name":"<agent name>"}}');
  });

  it('AETHER prompt addresses the user by a custom operatorName instead of the literal "Operator"', () => {
    const named: AetherState = { ...initialState, operatorName: 'Matt' };
    const prompt = buildSystemPrompt(aether, named);
    expect(prompt).toContain('"Matt."');
    expect(prompt).not.toContain('"Operator."');
  });

  it('per-agent channel prompt now also addresses the user by name (previously only AETHER did)', () => {
    const prompt = buildSystemPrompt(codeBuilder, initialState);
    expect(prompt).toContain('"Operator."');
  });

  it('archived-channel prompt also addresses the user by name', () => {
    const prompt = buildSystemPrompt(webScraper, initialState);
    expect(prompt).toContain('"Operator."');
  });
});
