import { describe, it, expect, afterEach } from 'vitest';
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
