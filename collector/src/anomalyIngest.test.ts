import { describe, it, expect } from 'vitest';
import { openDatabase, migrate } from './schema.js';
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';
import { join } from 'node:path';

function readEvent(id: string, name: string, path: string, ts: number, cwd: string | null = null): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: null, timestamp: new Date(ts), cwd, model: null, usage: null,
    toolUses: [{ id, name, input: { file_path: path } }], toolResults: [], humanText: null, originKind: null,
  };
}
function resultEvent(id: string, ts: number): TranscriptEvent {
  return {
    kind: 'user', sessionId: null, timestamp: new Date(ts), cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId: id, resultLength: 5 }], humanText: null, originKind: null,
  };
}

describe('ingestToolCallsAndAnomalies', () => {
  it('persists closed tool calls and flags a re-read-loop anomaly on the 3rd read', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    let history = createEmptyHistory();

    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(readEvent(`tu_${i}`, 'Read', 'src/foo.ts', 1000 + i * 100));
      events.push(resultEvent(`tu_${i}`, 1050 + i * 100));
    }

    const result = ingestToolCallsAndAnomalies(db, history, events, 2000);
    history = result.history;

    expect(result.toolCallsIngested).toBe(3);
    expect(result.anomaliesIngested).toBe(1);

    const rows = db.prepare('SELECT tool_name, file_path_rel FROM tool_calls').all() as { tool_name: string; file_path_rel: string }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ tool_name: 'Read', file_path_rel: 'src/foo.ts' });

    const anomalies = db.prepare('SELECT kind, detail FROM anomalies').all() as { kind: string; detail: string }[];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('reReadLoop');
    expect(anomalies[0].detail).toContain('src/foo.ts');
  });

  it('nulls out a relative file path that contains ".." traversal segments instead of persisting it', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const history = createEmptyHistory();

    const events: TranscriptEvent[] = [
      readEvent('tu_0', 'Read', '../../secret', 1000),
      resultEvent('tu_0', 1050),
    ];

    const result = ingestToolCallsAndAnomalies(db, history, events, 2000);
    expect(result.toolCallsIngested).toBe(1);

    const rows = db.prepare('SELECT file_path_rel FROM tool_calls').all() as { file_path_rel: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path_rel).toBeNull();
  });

  it('computes newlyClosed by toolUseId diff, not array index, so a tick that pushes past HISTORY_MAX_EVENTS still ingests exactly the new closures with no duplicates', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    // Simulate a history that's already at the 500-event cap from prior
    // ticks (those tool_calls rows were already persisted by those earlier
    // calls, not by this test). An index-based `before === after ? [] : ...`
    // slice would see length 500 -> 500 (one appended, one truncated from
    // the front) and either emit zero newly-closed rows (missing the new
    // closure) or -- for other size deltas -- reprocess stale entries.
    const priorEvents = Array.from({ length: 500 }, (_, i) => ({
      toolUseId: `tu_${i}`,
      toolName: 'Read',
      filePath: `file_${i}.ts`,
      startedAt: i,
      closedAt: i,
    }));
    const priorHistory = { events: priorEvents, openByToolUseId: {} };

    const events: TranscriptEvent[] = [
      readEvent('tu_500', 'Read', 'src/new-file.ts', 5000),
      resultEvent('tu_500', 5050),
    ];

    const result = ingestToolCallsAndAnomalies(db, priorHistory, events, 6000);

    expect(result.history.events).toHaveLength(500);
    expect(result.history.events[result.history.events.length - 1].toolUseId).toBe('tu_500');
    // Exactly the one genuinely new closure was ingested -- not zero
    // (the missed-closure failure mode) and not 500+ (the duplicate/stale
    // re-insert failure mode).
    expect(result.toolCallsIngested).toBe(1);

    const rows = db.prepare('SELECT tool_use_id FROM tool_calls').all() as { tool_use_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_use_id).toBe('tu_500');
  });

  it('relativizes an ABSOLUTE file_path against the event cwd, so neither file_path_rel nor any anomaly detail leaks the absolute/home path', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    const cwd = process.platform === 'win32' ? String.raw`C:\Users\Matt\projects\foo` : '/home/matt/projects/foo';
    const abs = join(cwd, 'src', 'bar.ts');

    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(readEvent(`tu_${i}`, 'Read', abs, 1000 + i * 100, cwd));
      events.push(resultEvent(`tu_${i}`, 1050 + i * 100));
    }

    const result = ingestToolCallsAndAnomalies(db, createEmptyHistory(), events, 2000);
    expect(result.anomaliesIngested).toBe(1);

    const rows = db.prepare('SELECT file_path_rel FROM tool_calls').all() as { file_path_rel: string | null }[];
    for (const r of rows) {
      expect(r.file_path_rel).toBe(join('src', 'bar.ts'));
      expect(r.file_path_rel).not.toContain(cwd);
    }

    const anomalies = db.prepare('SELECT detail FROM anomalies').all() as { detail: string }[];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].detail).not.toContain(cwd);
    expect(anomalies[0].detail).toContain(join('src', 'bar.ts'));
  });

  it('nulls an absolute file_path when the event carries no cwd to relativize against', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const abs = process.platform === 'win32' ? String.raw`C:\Users\Matt\secret.ts` : '/home/matt/secret.ts';

    const events: TranscriptEvent[] = [readEvent('tu_0', 'Read', abs, 1000), resultEvent('tu_0', 1050)];
    ingestToolCallsAndAnomalies(db, createEmptyHistory(), events, 2000);

    const rows = db.prepare('SELECT file_path_rel FROM tool_calls').all() as { file_path_rel: string | null }[];
    expect(rows[0].file_path_rel).toBeNull();
  });

  it('does not re-insert the same anomaly on a second scan tick while it is still inside the detection window', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(readEvent(`tu_${i}`, 'Read', 'src/foo.ts', 1000 + i * 100));
      events.push(resultEvent(`tu_${i}`, 1050 + i * 100));
    }

    const first = ingestToolCallsAndAnomalies(db, createEmptyHistory(), events, 2000);
    expect(first.anomaliesIngested).toBe(1);

    // Second tick: no new transcript events, but the same closures are still
    // inside the 5-minute window, so the detectors fire again.
    const second = ingestToolCallsAndAnomalies(db, first.history, [], 3000);
    expect(second.anomaliesIngested).toBe(0);

    const rows = db.prepare('SELECT id FROM anomalies').all();
    expect(rows).toHaveLength(1);
  });
});
