import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { ingestUsageEvent, ingestDispatchEvent } from './usageIngest.js';
import type { TranscriptEvent } from './transcriptParser.js';
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';
import { computeSeverity } from './personalitySpine.js';

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
    humanText: null,
    originKind: null,
    ...overrides,
  };
}

// Opens a dispatch the way a real transcript does: an assistant event whose
// tool_use is named 'Agent' (NOT 'Task' -- see src/state/liveAgentsMath.ts).
function openDispatch(toolUseId: string, startedAtMs: number, toolName = 'Agent') {
  return updateHistory(createEmptyHistory(), [{
    kind: 'assistant', sessionId: null, timestamp: new Date(startedAtMs), cwd: null, model: null, usage: null,
    toolUses: [{ id: toolUseId, name: toolName, input: { subagent_type: 'general-purpose' } }],
    toolResults: [], humanText: null, originKind: null,
  }], startedAtMs);
}

// The real completion signal: a 'user'-kind event with origin.kind
// 'task-notification' whose text carries tags Claude Code itself computes.
function completionEvent(
  toolUseId: string,
  endedAtMs: number,
  parts: { tokens?: number; toolUses?: number; durationMs?: number } = {},
): TranscriptEvent {
  const { tokens = 12345, toolUses = 7, durationMs = 4321 } = parts;
  return {
    kind: 'user', sessionId: null, timestamp: new Date(endedAtMs), cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [],
    humanText:
      `<tool-use-id>${toolUseId}</tool-use-id>` +
      `<subagent_tokens>${tokens}</subagent_tokens>` +
      `<tool_uses>${toolUses}</tool_uses>` +
      `<duration_ms>${durationMs}</duration_ms>`,
    originKind: 'task-notification',
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
  it('records exact tag-provided values when an Agent dispatch is closed by its task-notification', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);

    const ingested = ingestDispatchEvent(
      db,
      history,
      completionEvent('tu_1', 13000, { tokens: 12345, toolUses: 7, durationMs: 4321 }),
    );
    expect(ingested).toBe(true);

    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    // Exact values from the tags, NOT approximations derived from usage totals.
    expect(row.tokens).toBe(12345);
    expect(row.tool_uses).toBe(7);
    expect(row.duration_ms).toBe(4321);
    expect(row.started_at_ms).toBe(1000);
    expect(row.ended_at_ms).toBe(13000);
    db.close();
  });

  it('returns false and writes nothing when the tagged tool-use-id matches no open dispatch', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    expect(ingestDispatchEvent(db, history, completionEvent('tu_other', 13000))).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM dispatches').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('returns false when the notification carries no <tool-use-id> tag at all', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const event = { ...completionEvent('tu_1', 13000), humanText: 'subagent finished' };
    expect(ingestDispatchEvent(db, history, event)).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM dispatches').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('returns false for a non-user event or a user event that is not a task-notification', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const asAssistant = { ...completionEvent('tu_1', 13000), kind: 'assistant' as const };
    expect(ingestDispatchEvent(db, history, asAssistant)).toBe(false);
    const wrongOrigin = { ...completionEvent('tu_1', 13000), originKind: null };
    expect(ingestDispatchEvent(db, history, wrongOrigin)).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM dispatches').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('returns false when the open tool call is not named Agent', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000, 'Bash');
    expect(ingestDispatchEvent(db, history, completionEvent('tu_1', 13000))).toBe(false);
    db.close();
  });

  it('returns false when the completion event has no timestamp', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const event = { ...completionEvent('tu_1', 13000), timestamp: null };
    expect(ingestDispatchEvent(db, history, event)).toBe(false);
    db.close();
  });

  it('defaults missing numeric tags to 0 rather than failing', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const event = { ...completionEvent('tu_1', 13000), humanText: '<tool-use-id>tu_1</tool-use-id>' };
    expect(ingestDispatchEvent(db, history, event)).toBe(true);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    expect(row.tokens).toBe(0);
    expect(row.tool_uses).toBe(0);
    expect(row.duration_ms).toBe(0);
    db.close();
  });

  // Regression: the pre-rework version fanned a single completion out to EVERY
  // open dispatch, so a second concurrent dispatch got a bogus row. The
  // <tool-use-id> tag is an exact correlation id -- exactly one row per event.
  it('closes only the tagged dispatch when two dispatches are open concurrently', () => {
    const db = freshDb();
    let history = openDispatch('tu_a', 1000);
    history = updateHistory(history, [{
      kind: 'assistant', sessionId: null, timestamp: new Date(2000), cwd: null, model: null, usage: null,
      toolUses: [{ id: 'tu_b', name: 'Agent', input: {} }], toolResults: [], humanText: null, originKind: null,
    }], 2000);
    expect(Object.keys(history.openByToolUseId).sort()).toEqual(['tu_a', 'tu_b']);

    expect(ingestDispatchEvent(db, history, completionEvent('tu_a', 13000, { tokens: 500 }))).toBe(true);

    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].tool_use_id).toBe('tu_a');
    expect(rows[0].tokens).toBe(500);
    db.close();
  });

  it('upserts on a repeated completion for the same dispatch rather than duplicating the row', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    ingestDispatchEvent(db, history, completionEvent('tu_1', 13000, { tokens: 100 }));
    ingestDispatchEvent(db, history, completionEvent('tu_1', 14000, { tokens: 250 }));
    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].tokens).toBe(250);
    expect(rows[0].ended_at_ms).toBe(14000);
    db.close();
  });

  it('populates task_kind/agent_id/session_id/retries/exit_state/severity/median_ms_at_eval on real completion', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    history.openByToolUseId['tu_1'].sessionId = 'sess-abc';

    const event = completionEvent('tu_1', 13000, { durationMs: 4321 });
    expect(ingestDispatchEvent(db, history, event)).toBe(true);

    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    expect(row.task_kind).toBe('general-purpose');
    expect(row.agent_id).toBe('general-purpose');
    expect(row.session_id).toBe('sess-abc');
    expect(row.retries).toBe(0);
    expect(row.exit_state).toBe('ok');
    expect(row.median_ms_at_eval).toBeNull();
    const expectedSeverity = computeSeverity({
      exit: 'ok',
      retries: 0,
      elapsedMs: 4321,
      medianMsAtEval: null,
    });
    expect(row.severity).toBe(expectedSeverity);
    expect(expectedSeverity).toBe(1);
    db.close();
  });

  it('writes task_kind/agent_id as null when the open dispatch has no subagent_type', () => {
    const db = freshDb();
    const history = updateHistory(createEmptyHistory(), [{
      kind: 'assistant', sessionId: null, timestamp: new Date(1000), cwd: null, model: null, usage: null,
      toolUses: [{ id: 'tu_1', name: 'Agent', input: {} }],
      toolResults: [], humanText: null, originKind: null,
    }], 1000);

    expect(ingestDispatchEvent(db, history, completionEvent('tu_1', 13000))).toBe(true);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    expect(row.task_kind).toBeNull();
    expect(row.agent_id).toBeNull();
    db.close();
  });

  it('never persists the raw notification text anywhere in the dispatches row', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const event = completionEvent('tu_1', 13000);
    ingestDispatchEvent(db, history, event);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    expect(JSON.stringify(row)).not.toContain('subagent_tokens');
    db.close();
  });
});
