// src/shared/projectsSnapshot.test.ts
import { describe, it, expect } from 'vitest';
import type { TranscriptEvent } from '../../electron/transcriptParser';
import { buildProjectsSnapshot } from './projectsSnapshot';
import { sessionLedger } from './ledgerMath';
import { normalizePath, type GitProbe } from './projectIdentity';

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
const M = 1_000_000;

const AETHER = 'C:\\Users\\IT\\Desktop\\Aether-OS';
const TOKEN = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2';
const probe: GitProbe = (dir) =>
  [AETHER, TOKEN].map(normalizePath).includes(normalizePath(dir));

// Identity key function -- the real one hashes; tests want readable keys.
const keyOf = (repoPath: string) => repoPath;

function ev(cwd: string | null, outputTokens: number): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: 's', timestamp: new Date(NOW), cwd,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 0, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [], toolResults: [], isHumanPrompt: false, humanText: null, originKind: null,
  };
}

describe('buildProjectsSnapshot', () => {
  it('returns empty roots and null unscoped for no events', () => {
    const s = buildProjectsSnapshot([], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toEqual([]);
    expect(s.unscoped).toBeNull();
  });

  it('groups events under their repo', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(TOKEN, M / 2)], probe, keyOf, 'UTC', NOW);
    expect(s.roots.map((r) => r.name)).toEqual(['aether-os', 'tokenmonitorv2']);
  });

  it('sorts roots by cost descending', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M / 4), ev(TOKEN, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots.map((r) => r.name)).toEqual(['tokenmonitorv2', 'aether-os']);
  });

  it('nests a worktree under its parent and includes it in the parent total', () => {
    const wt = `${AETHER}\\.claude\\worktrees\\statusline-feed`;
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(wt, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toHaveLength(1);
    const root = s.roots[0];
    expect(root.name).toBe('aether-os');
    // 2M output tokens at the sonnet $15/Mtok rate.
    expect(root.ledger.total.usd).toBeCloseTo(30, 6);
    expect(root.children.map((c) => c.worktree)).toEqual([null, 'statusline-feed']);
  });

  // Invariant 2 from the spec: expanded rows must add up on screen.
  it('children sum exactly to their parent total', () => {
    const wt1 = `${AETHER}\\.claude\\worktrees\\a`;
    const wt2 = `${AETHER}\\.claude\\worktrees\\b`;
    const s = buildProjectsSnapshot([ev(AETHER, M), ev(wt1, M / 2), ev(wt2, M / 4)], probe, keyOf, 'UTC', NOW);
    const root = s.roots[0];
    const sum = root.children.reduce((a, c) => a + c.ledger.total.usd, 0);
    expect(sum).toBeCloseTo(root.ledger.total.usd, 10);
  });

  it('omits the children list when a repo has only its own checkout', () => {
    const s = buildProjectsSnapshot([ev(AETHER, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots[0].children).toHaveLength(1);
  });

  it('buckets unattributable events as unscoped rather than dropping them', () => {
    const s = buildProjectsSnapshot([ev('C:\\Users\\IT', M), ev(null, M)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toEqual([]);
    expect(s.unscoped!.total.usd).toBeCloseTo(30, 6);
  });

  // Invariant 1 from the spec: nothing may be silently dropped.
  it('roots plus unscoped equal the all-transcripts total', () => {
    const wt = `${AETHER}\\.claude\\worktrees\\a`;
    const events = [ev(AETHER, M), ev(wt, M), ev(TOKEN, M / 2), ev('C:\\Users\\IT', M / 4), ev(null, M / 8)];
    const s = buildProjectsSnapshot(events, probe, keyOf, 'UTC', NOW);
    const summed =
      s.roots.reduce((a, r) => a + r.ledger.total.usd, 0) + (s.unscoped?.total.usd ?? 0);
    expect(summed).toBeCloseTo(sessionLedger(events).usd, 10);
  });

  it('keeps a project with observed but zero-cost activity, at 0 rather than dropped', () => {
    const s = buildProjectsSnapshot([ev(AETHER, 0)], probe, keyOf, 'UTC', NOW);
    expect(s.roots).toHaveLength(1);
    expect(s.roots[0].ledger.total.usd).toBe(0);
  });
});
