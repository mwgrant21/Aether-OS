import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveSubagentProgress } from './liveSubagentProgress';
import { createLiveSeverityNarrator } from './liveSeverity';
import { createTickCompletionHandler } from '../liveTickCompletions';
import { STALL_MS } from './isStalled';
import { narrationLine, formatNarration } from '../narrationGenerator';
import type { CompletedDispatchUsage, TrackedOutcome } from '../../src/state/liveAgentsMath';

// Synthetic temp trees only; never the real ~/.claude/projects.
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function projectsRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'aether-liveprog-'));
  roots.push(r);
  return r;
}
const errLine = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'secret text' }] } });
function addSub(root: string, proj: string, session: string, agent: string, toolUseId: string, nErrors: number): string {
  const d = join(root, proj, session, 'subagents');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `agent-${agent}.meta.json`), JSON.stringify({ toolUseId }));
  const f = join(d, `agent-${agent}.jsonl`);
  writeFileSync(f, Array.from({ length: nErrors }, () => errLine).join('\n') + '\n');
  return f;
}
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const dispatch = (id: string): CompletedDispatchUsage => ({ toolUseId: id, subagentType: 'code-reviewer', description: '', startedAt: new Date(T0).toISOString(), prompt: '', model: null });
const tracked = (status: 'completed' | 'killed'): TrackedOutcome => ({ outcome: { status, usage: { tokens: 1, toolUses: 1, durationMs: 1000 } }, unknownStatusTag: null });

function narrateFor(prog: ReturnType<typeof createLiveSubagentProgress>, sessionId: string, id: string, status: 'completed' | 'killed') {
  const out: number[] = [];
  const handle = createTickCompletionHandler({
    narrator: createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => true }, narrate: narrationLine }),
    reportUnseenStatus: () => {},
    sendNarration: (p) => out.push(p.severity),
    sendCompleted: () => {},
    toolErrorsFor: (tid) => prog.toolErrorsFor(sessionId, tid),
  });
  handle({ completed: [dispatch(id)], outcomes: new Map([[id, tracked(status)]]) });
  return out;
}

describe('live tool-error floor through the completion handler', () => {
  it('3 errors in the subagent file -> narrated at 3; subagents under another project dir -> 3; nested sibling -> 3', () => {
    const root = projectsRoot();
    addSub(root, 'proj-a', 'sess-1', 'a1', 'toolu_A', 3);
    addSub(root, 'proj-b', 'sess-2', 'b1', 'toolu_B', 3);
    addSub(root, 'proj-a', 'sess-3', 'n1', 'toolu_N', 4);
    addSub(root, 'proj-a', 'sess-3', 'n0', 'toolu_N0', 0);
    const prog = createLiveSubagentProgress(root);
    expect(narrateFor(prog, 'sess-1', 'toolu_A', 'completed')).toEqual([3]);
    expect(narrateFor(prog, 'sess-2', 'toolu_B', 'completed')).toEqual([3]);
    expect(narrateFor(prog, 'sess-3', 'toolu_N', 'completed')).toEqual([3]);
  });
  it('no link -> severity from status alone; killed with 5 errors -> 2', () => {
    const root = projectsRoot();
    addSub(root, 'proj-a', 'sess-1', 'a1', 'toolu_K', 5);
    const prog = createLiveSubagentProgress(root);
    expect(narrateFor(prog, 'sess-1', 'toolu_nolink', 'completed')).toEqual([1]);
    expect(narrateFor(prog, 'sess-1', 'toolu_K', 'killed')).toEqual([2]);
  });
});

describe('live stall progress from the subagent file', () => {
  const NOW = T0 + 2 * STALL_MS;
  function stalledWith(mtimeMs: number): number {
    const root = projectsRoot();
    const f = addSub(root, 'proj-a', 'sess-1', 'a1', 'toolu_P', 0);
    utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
    const prog = createLiveSubagentProgress(root);
    const n = createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => true }, narrate: narrationLine });
    return n.checkStalls([dispatch('toolu_P')], NOW, false, (id) => prog.lastWriteMsFor('sess-1', id)).length;
  }
  it('written 1 min ago after 60 min from start -> not stalled', () => expect(stalledWith(NOW - 60_000)).toBe(0));
  it('quiet for 31 min -> stalled', () => expect(stalledWith(NOW - 31 * 60_000)).toBe(1));
  it('future mtime within 5 min -> progress; beyond 5 min -> ignored (stalled from start)', () => {
    expect(stalledWith(NOW + 4 * 60_000)).toBe(0);
    expect(stalledWith(NOW + 6 * 60_000)).toBe(1);
  });
  it('no link -> measured from dispatch start', () => {
    const prog = createLiveSubagentProgress(projectsRoot());
    const n = createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => true }, narrate: narrationLine });
    expect(n.checkStalls([dispatch('toolu_none')], NOW, false, (id) => prog.lastWriteMsFor('sess-1', id))).toHaveLength(1);
  });
});

describe('session eviction', () => {
  it('two sessions in turn leave one entry: the first session is rebuilt when asked again', () => {
    const root = projectsRoot();
    addSub(root, 'proj-a', 'sess-1', 'a1', 'toolu_1', 1);
    addSub(root, 'proj-a', 'sess-2', 'b1', 'toolu_2', 1);
    const prog = createLiveSubagentProgress(root);
    expect(prog.toolErrorsFor('sess-1', 'toolu_1')).toBe(1);
    expect(prog.toolErrorsFor('sess-2', 'toolu_2')).toBe(1);
    // A file added to sess-1 after eviction is visible only if sess-1 was rebuilt.
    addSub(root, 'proj-a', 'sess-1', 'a2', 'toolu_3', 2);
    expect(prog.toolErrorsFor('sess-1', 'toolu_3')).toBe(2);
  });
});

describe('probe caching', () => {
  it('a miss rescans at most once per refresh window; a late meta.json is picked up after it', () => {
    const root = projectsRoot();
    let t = 1_000_000;
    const prog = createLiveSubagentProgress(root, () => t, 15_000);
    expect(prog.lastWriteMsFor('sess-1', 'toolu_L')).toBeNull();
    addSub(root, 'proj-a', 'sess-1', 'l1', 'toolu_L', 0);
    t += 5_000;
    expect(prog.lastWriteMsFor('sess-1', 'toolu_L')).toBeNull(); // throttled: no rescan yet
    t += 15_000;
    expect(prog.lastWriteMsFor('sess-1', 'toolu_L')).not.toBeNull();
  });
});

describe('privacy', () => {
  it('counts only: no transcript text in the count or the narration payload', () => {
    const root = projectsRoot();
    addSub(root, 'proj-a', 'sess-1', 'a1', 'toolu_A', 3);
    const prog = createLiveSubagentProgress(root);
    expect(JSON.stringify([prog.toolErrorsFor('sess-1', 'toolu_A'), formatNarration({ subagentType: 'code-reviewer' }, 3)])).not.toContain('secret text');
  });
});
