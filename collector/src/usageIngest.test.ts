import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { ingestUsageEvent, ingestDispatchEvent } from './usageIngest.js';
import type { TranscriptEvent } from './transcriptParser.js';
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-usageingest-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function assistantEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: 's1',
    timestamp: new Date('2026-07-08T09:00:00Z'),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [],
    toolResults: [],
    originKind: null,
    ...overrides,
  };
}

describe('ingestUsageEvent', () => {
  it('inserts a row for an assistant event with usage and returns true', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent());
    expect(inserted).toBe(true);
    const row: any = db.prepare('SELECT * FROM usage_events').get();
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.input_tokens).toBe(100);
    expect(row.occurred_at_ms).toBe(new Date('2026-07-08T09:00:00Z').getTime());
    db.close();
  });

  it('skips a user-kind event and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ kind: 'user' }));
    expect(inserted).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('skips an assistant event with null usage and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ usage: null }));
    expect(inserted).toBe(false);
    db.close();
  });

  it('skips an event with a null timestamp and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ timestamp: null }));
    expect(inserted).toBe(false);
    db.close();
  });

  it('stores a null model as SQL NULL, not the string "null"', () => {
    const db = freshDb();
    ingestUsageEvent(db, assistantEvent({ model: null }));
    const row: any = db.prepare('SELECT model FROM usage_events').get();
    expect(row.model).toBeNull();
    db.close();
  });
});

describe('ingestDispatchEvent', () => {
  it('records a dispatches row when a Task tool call is still open', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    let history = createEmptyHistory();
    history = updateHistory(history, [{
      kind: 'assistant', sessionId: null, timestamp: new Date(1000), cwd: null, model: null, usage: null,
      toolUses: [{ id: 'tu_task_1', name: 'Task', input: {} }], toolResults: [], originKind: null,
    }], 1000);

    const completionEvent = {
      kind: 'assistant' as const, sessionId: null, timestamp: new Date(13000), cwd: null,
      model: 'claude-sonnet-5',
      usage: { inputTokens: 4000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      toolUses: [], toolResults: [], originKind: null,
    };

    const ingested = ingestDispatchEvent(db, history, completionEvent, 'tu_task_1', 3);
    expect(ingested).toBe(true);

    const row = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_task_1') as
      { tokens: number; tool_uses: number; started_at_ms: number; ended_at_ms: number };
    expect(row.tokens).toBe(5000);
    expect(row.tool_uses).toBe(3);
    expect(row.started_at_ms).toBe(1000);
    expect(row.ended_at_ms).toBe(13000);
  });
});
