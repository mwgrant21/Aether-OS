import { describe, it, expect } from 'vitest';
import { openDatabase, migrate } from './schema.js';
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';

function readEvent(id: string, name: string, path: string, ts: number): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: null, timestamp: new Date(ts), cwd: null, model: null, usage: null,
    toolUses: [{ id, name, input: { file_path: path } }], toolResults: [],
  };
}
function resultEvent(id: string, ts: number): TranscriptEvent {
  return {
    kind: 'user', sessionId: null, timestamp: new Date(ts), cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId: id, resultLength: 5 }],
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

    const result = ingestToolCallsAndAnomalies(db, history, events, 2000, 'proj-a');
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
});
