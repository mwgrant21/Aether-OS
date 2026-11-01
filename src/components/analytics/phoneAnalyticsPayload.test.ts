import { describe, it, expect } from 'vitest';
import { phoneAnalyticsPayload } from './phoneAnalyticsPayload';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const agent = (id: string, ageMs: number, extra: object = {}) =>
  ({ toolUseId: id, subagentType: 'builder', description: `desc ${id}`, startedAt: iso(NOW - ageMs), prompt: 'SECRET-PROMPT', model: null, ...extra });
const get = (s: Partial<AetherState>) => phoneAnalyticsPayload({ ...initialState, ...s } as AetherState, NOW) as any;

describe('phoneAnalyticsPayload', () => {
  it('is empty-but-valid on the initial state and stamps the publish instant', () => {
    expect(get({})).toEqual({ computedAtMs: NOW, logs: { success: 0, info: 0, denied: 0, other: 0 }, longest: [], burn: [], commands: [] });
  });
  it('counts logs by bucket without sending any log text', () => {
    const logs = [{ t: '1', m: 'SECRET-LOG', c: '#3be0a0' }, { t: '2', m: 'x', c: '#3be0a0' }, { t: '3', m: 'x', c: '#7fd8ef' }, { t: '4', m: 'x', c: '#ff9d9d' }, { t: '5', m: 'x', c: 'weird' }];
    const p = get({ logs });
    expect(p.logs).toEqual({ success: 2, info: 1, denied: 1, other: 1 });
    expect(JSON.stringify(p)).not.toContain('SECRET-LOG');
  });
  it('lists the 8 longest-running dispatches, longest first, as start instants, with no prompt', () => {
    const realAgents = Array.from({ length: 10 }, (_, i) => agent(`a${i}`, (i + 1) * 1000));
    const p = get({ realAgents });
    expect(p.longest).toHaveLength(8);
    expect(p.longest[0]).toEqual({ type: 'builder', description: 'desc a9', startedAtMs: NOW - 10_000 });
    expect(Object.keys(p.longest[0])).toEqual(['type', 'description', 'startedAtMs']);
    expect(JSON.stringify(p)).not.toContain('SECRET-PROMPT');
  });
  it('ranks the top 5 completed dispatches by tokens and nulls a non-finite toolUses', () => {
    const pool = Array.from({ length: 7 }, (_, i) => agent(`d${i}`, 0));
    const dispatchUsage = Object.fromEntries(pool.map((d, i) => [d.toolUseId, { tokens: (i + 1) * 100, toolUses: i === 6 ? NaN : i, durationMs: 5 }]));
    const p = get({ recentCompletedDispatches: pool, dispatchUsage });
    expect(p.burn.map((b: any) => b.tokens)).toEqual([700, 600, 500, 400, 300]);
    expect(p.burn[0].toolUses).toBeNull();
    expect(Object.keys(p.burn[1]).sort()).toEqual(['description', 'durationMs', 'tokens', 'toolUses', 'type']);
  });
  it('drops a row with a non-finite number instead of nulling the payload', () => {
    const p = get({
      realAgents: [agent('ok', 1000), agent('bad', 0, { startedAt: 'not a date' })],
      recentCompletedDispatches: [agent('t1', 0), agent('t2', 0)],
      dispatchUsage: { t1: { tokens: NaN, toolUses: 1, durationMs: 1 }, t2: { tokens: 10, toolUses: 1, durationMs: 1 } },
    });
    expect(p.longest.map((l: any) => l.description)).toEqual(['desc ok']);
    expect(p.burn.map((b: any) => b.description)).toEqual(['desc t2']);
  });
  it('keeps the valid burn rows in token order when a NaN-token row sits between them', () => {
    const pool = ['a', 'b', 'c', 'd', 'nan', 'e'].map((id) => agent(id, 0));
    const tok: Record<string, number> = { a: 100, b: 300, c: 400, d: 500, nan: NaN, e: 200 };
    const dispatchUsage = Object.fromEntries(pool.map((d) => [d.toolUseId, { tokens: tok[d.toolUseId], toolUses: 1, durationMs: 1 }]));
    const p = get({ recentCompletedDispatches: pool, dispatchUsage });
    expect(p.burn.map((b: any) => b.tokens)).toEqual([500, 400, 300, 200, 100]);
  });
  it('sends only the first word of each persisted command (cmdHist), lower-cased, top 5, never a command line', () => {
    const cmdHist = ['status now', 'Status', 'budget --verbose SECRET-ARG', 'a', 'b', 'c', 'd'];
    const p = get({ cmdHist, sessionCommandHistory: ['onlysession x'] } as Partial<AetherState>);
    expect(p.commands).toHaveLength(5);
    expect(p.commands[0]).toEqual({ name: 'status', count: 2 });
    expect(p.commands.every((c: any) => !/\s/.test(c.name))).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/SECRET-ARG|--verbose|onlysession/);
  });
  it('masks a secret first word before reducing, so AKIA and JWT tokens never survive lower-cased', () => {
    const akia = 'AKIAIOSFODNN7EXAMPLE';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const p = get({ cmdHist: [akia + ' --region us', jwt, 'Status', 'status now'] });
    expect(p.commands).toContainEqual({ name: '[redacted]', count: 2 });
    expect(p.commands).toContainEqual({ name: 'status', count: 2 });
    expect(JSON.stringify(p)).not.toMatch(/akiaiosfodnn7example|AKIAIOSFODNN7EXAMPLE|eyjhbgci|eyJhbGci/);
  });
  it('keeps the first word of an ordinary command line that carries a secret later in the line', () => {
    const p = get({ cmdHist: ['deploy --token sk-ant-abcdefghijklmnopqrstuvwxyz0123'] });
    expect(p.commands).toEqual([{ name: 'deploy', count: 1 }]);
  });
});
