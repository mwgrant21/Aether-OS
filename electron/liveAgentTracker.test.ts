import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createLiveAgentTracker } from './liveAgentTracker';
import { createLiveSeverityNarrator } from './severity/liveSeverity';
import { narrationLine } from './narrationGenerator';
import { cwdToProjectDirName } from '../src/state/projectDirName';

// Synthetic session file in the real JSONL shape; no copied transcript content.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function homeWithSession(lines: unknown[]): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'aether-tracker-'));
  dirs.push(home);
  const sessionDir = path.join(home, '.claude', 'projects', cwdToProjectDirName(home));
  mkdirSync(sessionDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l) + '\n').join('');
  writeFileSync(path.join(sessionDir, 'synthetic-session.jsonl'), body, 'utf8');
  return home;
}

describe('liveAgentTracker.tick() -> outcomes (end to end)', () => {
  it('a failed completion notification yields outcome status failed, and the narrator then gives severity 4', async () => {
    const home = homeWithSession([
      { type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu_e2e', name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } },
      { type: 'user', timestamp: '2026-09-30T10:02:00.000Z', origin: { kind: 'task-notification' }, message: { content: '<task-notification><tool-use-id>tu_e2e</tool-use-id><status>failed</status><summary>x</summary></task-notification>' } },
    ]);
    const tracker = createLiveAgentTracker(home);
    tracker.notifyPtySpawned(0);
    const result = await tracker.tick();
    expect(result.completed.map((c) => c.toolUseId)).toEqual(['tu_e2e']);
    const tracked = result.outcomes.get('tu_e2e');
    expect(tracked).toEqual({ outcome: { status: 'failed' }, unknownStatusTag: null });
    const narrator = createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => true }, narrate: narrationLine });
    expect(narrator.onCompleted(result.completed[0], tracked)).toEqual({ toolUseId: 'tu_e2e', severity: 4, subagentType: 'code-reviewer', final: true, narration: narrationLine('code-reviewer', 4) });
  });

  // main.ts calls tick() from the periodic agent tick AND from onPostToolUse,
  // with no shared guard. Two overlapping calls must not both read from the
  // same offset (double narration, double baseline sample, double
  // agents:completed) or write back a smaller offset (re-read).
  it('two concurrent tick() calls yield exactly one completion in total, and the offset never regresses', async () => {
    const home = homeWithSession([
      { type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu_c', name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } },
      { type: 'user', timestamp: '2026-09-30T10:02:00.000Z', origin: { kind: 'task-notification' }, message: { content: '<task-notification><tool-use-id>tu_c</tool-use-id><status>completed</status><summary>x</summary></task-notification>' } },
    ]);
    const tracker = createLiveAgentTracker(home);
    tracker.notifyPtySpawned(0);
    const [a, b] = await Promise.all([tracker.tick(), tracker.tick()]);
    expect([...a.completed, ...b.completed].map((c) => c.toolUseId)).toEqual(['tu_c']);
    expect(a.outcomes.size + b.outcomes.size).toBe(1);
    // A regressed offset would re-read the file: the dispatch would open and
    // complete again on the next tick.
    const c = await tracker.tick();
    expect(c.completed).toEqual([]);
    expect(c.open).toEqual([]);
  });

  it('an idle tick (nothing pinned yet) still carries an empty outcomes map', async () => {
    const tracker = createLiveAgentTracker(homeWithSession([]));
    const result = await tracker.tick();
    expect(result.outcomes).toEqual(new Map());
  });
});

// A pty respawn (notifyPtySpawned) can land while a tick is awaiting the
// filesystem. Deferred fs promises make the interleaving deterministic.
describe('liveAgentTracker: respawn while a tick is in flight', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  // Synthetic lines: an Agent launch that also carries usage (feeds the
  // cumulative counters behind cacheHitRatio).
  const oldLines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { usage: { input_tokens: 100, cache_read_input_tokens: 900 }, content: [{ type: 'tool_use', id: 'tu_old', name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } }),
  ];
  const newLines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-30T11:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu_new', name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } }),
  ];

  it('respawn during readNewLines: the stale tick returns empty and writes no state; the next tick reads the NEW file from offset 0', async () => {
    const reads: [string, number][] = [];
    const oldRead = deferred<{ lines: string[]; newOffset: number }>();
    let findCalls = 0;
    const tracker = createLiveAgentTracker('/home/x', {
      findSessionFile: async () => (++findCalls === 1 ? '/s/old.jsonl' : '/s/new.jsonl'),
      readLines: (file, offset) => {
        reads.push([file, offset]);
        return file === '/s/old.jsonl' ? oldRead.promise : Promise.resolve({ lines: newLines, newOffset: 50 });
      },
    });
    tracker.notifyPtySpawned(1000);
    const stale = tracker.tick();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    tracker.notifyPtySpawned(2000);
    oldRead.resolve({ lines: oldLines, newOffset: 400 });
    const s = await stale;
    expect(s.open).toEqual([]);
    expect(s.completed).toEqual([]);
    expect(s.cacheHitRatio).toBe(0);
    const next = await tracker.tick();
    expect(reads).toEqual([['/s/old.jsonl', 0], ['/s/new.jsonl', 0]]);
    expect(next.open.map((d) => d.toolUseId)).toEqual(['tu_new']);
    // Old-file usage never reached the counters.
    expect(next.cacheHitRatio).toBe(0);
    expect(tracker.getPinnedSessionId()).toBe('new');
  });

  it('respawn during findSessionFileCreatedAfter: the old session file is never pinned; the next tick pins the file created after the NEW spawn', async () => {
    const finds: number[] = [];
    const oldFind = deferred<string | null>();
    const reads: string[] = [];
    const tracker = createLiveAgentTracker('/home/x', {
      findSessionFile: (_dir, sinceMs) => {
        finds.push(sinceMs);
        return sinceMs === 1000 ? oldFind.promise : Promise.resolve('/s/new.jsonl');
      },
      readLines: async (file) => {
        reads.push(file);
        return file === '/s/new.jsonl' ? { lines: newLines, newOffset: 50 } : { lines: oldLines, newOffset: 400 };
      },
    });
    tracker.notifyPtySpawned(1000);
    const stale = tracker.tick();
    await vi.waitFor(() => expect(finds).toHaveLength(1));
    tracker.notifyPtySpawned(2000);
    oldFind.resolve('/s/old.jsonl');
    const s = await stale;
    expect(s.open).toEqual([]);
    expect(tracker.getPinnedSessionId()).toBeNull();
    const next = await tracker.tick();
    expect(finds).toEqual([1000, 2000]);
    expect(reads).toEqual(['/s/new.jsonl']);
    expect(tracker.getPinnedSessionId()).toBe('new');
    expect(next.open.map((d) => d.toolUseId)).toEqual(['tu_new']);
  });

  it('a normal tick with no respawn is unaffected', async () => {
    const tracker = createLiveAgentTracker('/home/x', {
      findSessionFile: async () => '/s/old.jsonl',
      readLines: async () => ({ lines: oldLines, newOffset: 400 }),
    });
    tracker.notifyPtySpawned(1000);
    const r = await tracker.tick();
    expect(r.open.map((d) => d.toolUseId)).toEqual(['tu_old']);
    expect(r.cacheHitRatio).toBeCloseTo(0.9, 6);
    expect(tracker.getPinnedSessionId()).toBe('old');
  });
});
