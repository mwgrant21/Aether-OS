import { describe, it, expect } from 'vitest';
import { phoneAgentsPayload } from './phoneAgentsPayload';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const NOW = 1_800_000_000_000;
const AKIA = 'AKIAIOSFODNN7EXAMPLE';
const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, ageMs = 1000, extra: object = {}) =>
  ({ toolUseId: id, subagentType: 'builder', description: `desc ${id}`, startedAt: iso(NOW - ageMs), prompt: `prompt ${id}`, model: 'claude-x', ...extra });
const get = (s: Partial<AetherState>) => phoneAgentsPayload({ ...initialState, ...s } as AetherState, NOW) as any;

describe('phoneAgentsPayload', () => {
  it('is empty-but-valid on the initial state and stamps the publish instant', () => {
    expect(get({})).toEqual({ computedAtMs: NOW, running: [], done: [] });
  });
  it('lists NEEDS INPUT before WORKING, and needsInput is exactly "has an anomaly"', () => {
    const p = get({
      realAgents: [agent('w1'), agent('n1'), agent('w2')],
      anomalies: [{ kind: 'reReadLoop', toolUseId: 'n1', detail: 'a.ts read 5 times' }, { kind: 'zeroEditBurn', toolUseId: 'ghost', detail: 'x' }],
    });
    expect(p.running.map((r: any) => [r.id, r.needsInput, r.anomaly?.kind ?? null])).toEqual([['n1', true, 'reReadLoop'], ['w1', false, null], ['w2', false, null]]);
    expect(p.running[0].anomaly.detail).toBe('a.ts read 5 times');
  });
  it('uses the headline and narration from state, with the description as headline fallback and a silent dial honoured', () => {
    const base = { realAgents: [agent('a'), agent('b')], dispatchHeadlines: { a: 'Headline A' }, dispatchNarrations: { a: { narration: 'Doing A', severity: 1 }, b: { narration: 'Doing B', severity: 4 } } };
    let p = get(base);
    expect(p.running.map((r: any) => [r.headline, r.narration])).toEqual([['Headline A', 'Doing A'], ['desc b', 'Doing B']]);
    p = get({ ...base, cfg: { ...initialState.cfg, narrationVerbosity: 'silent' } });
    expect(p.running.map((r: any) => r.narration)).toEqual([null, 'Doing B']); // severity 4 passes the floor
  });
  it('masks the RAW text before capping: an AKIA key in a prompt, description, headline and narration never survives, even straddling the cap', () => {
    const p = get({
      realAgents: [agent('a', 1000, { prompt: `${'p'.repeat(1180)} ${AKIA}`, description: `${'d'.repeat(114)} ${AKIA}` })],
      dispatchHeadlines: { a: `${'h'.repeat(114)} ${AKIA}` },
      dispatchNarrations: { a: { narration: `${'n'.repeat(154)} ${AKIA}`, severity: 1 } },
    });
    const r = p.running[0];
    for (const f of [r.prompt, r.description, r.headline, r.narration]) expect(f).not.toMatch(/AKIA/);
    expect(r.prompt.length).toBeLessThanOrEqual(1200);
    expect(`${r.prompt} ${r.description} ${r.headline} ${r.narration}`).toContain('[redacted]');
  });
  it('lists done dispatches from recentCompletedDispatches with usage, capped at 20, and nulls a non-finite or absent usage number', () => {
    const done = Array.from({ length: 25 }, (_, i) => agent(`d${i}`));
    const p = get({ recentCompletedDispatches: done, dispatchUsage: { d0: { tokens: 10, toolUses: 2, durationMs: 300 }, d1: { tokens: NaN, toolUses: 1, durationMs: -5 } } });
    expect(p.done).toHaveLength(20);
    expect(p.done[0]).toEqual({ id: 'd0', type: 'builder', description: 'desc d0', startedAtMs: NOW - 1000, tokens: 10, toolUses: 2, durationMs: 300, headline: 'desc d0' });
    expect([p.done[1].tokens, p.done[1].toolUses, p.done[1].durationMs, p.done[2].tokens]).toEqual([null, 1, null, null]);
  });
  it('drops a dispatch with an unparseable start or an unsafe id instead of nulling the payload, and never sends a prompt for done rows', () => {
    const p = get({
      realAgents: [agent('ok'), agent('bad', 1000, { startedAt: 'nope' }), agent('has space')],
      recentCompletedDispatches: [agent('d1'), agent('../x')],
    });
    expect(p.running.map((r: any) => r.id)).toEqual(['ok']);
    expect(p.done.map((r: any) => r.id)).toEqual(['d1']);
    expect(Object.keys(p.done[0]).sort()).toEqual(['description', 'durationMs', 'headline', 'id', 'startedAtMs', 'tokens', 'toolUses', 'type']);
  });
  it('caps the running list at 30', () => {
    expect(get({ realAgents: Array.from({ length: 40 }, (_, i) => agent(`r${i}`)) }).running).toHaveLength(30);
  });
});
