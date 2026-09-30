import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { ingestUsageEvent, ingestDispatchEvent, medianDurationMsFor } from './usageIngest.js';
import type { TranscriptEvent } from './transcriptParser.js';
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';
import { computeSeverity } from './severity/computeSeverity.js';

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
    const inserted = ingestUsageEvent(db, assistantEvent(), 'my-project/sess-1.jsonl');
    expect(inserted).toBe(true);
    const row: any = db.prepare('SELECT * FROM usage_events').get();
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.input_tokens).toBe(100);
    expect(row.occurred_at_ms).toBe(new Date('2026-07-08T09:00:00Z').getTime());
    db.close();
  });

  it('skips a user-kind event and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ kind: 'user' }), 'my-project/sess-1.jsonl');
    expect(inserted).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('skips an assistant event with null usage and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ usage: null }), 'my-project/sess-1.jsonl');
    expect(inserted).toBe(false);
    db.close();
  });

  it('skips an event with a null timestamp and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ timestamp: null }), 'my-project/sess-1.jsonl');
    expect(inserted).toBe(false);
    db.close();
  });

  it('stores a null model as SQL NULL, not the string "null"', () => {
    const db = freshDb();
    ingestUsageEvent(db, assistantEvent({ model: null }), 'my-project/sess-1.jsonl');
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

  it('stores NULL usage columns when the notification carries no usage tags', () => {
    const db = freshDb();
    const history = openDispatch('tu_1', 1000);
    const event = { ...completionEvent('tu_1', 13000), humanText: '<tool-use-id>tu_1</tool-use-id>' };
    expect(ingestDispatchEvent(db, history, event)).toBe(true);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_1');
    expect(row.tokens).toBeNull();
    expect(row.tool_uses).toBeNull();
    expect(row.duration_ms).toBeNull();
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
      elapsedMs: 4321,
      medianMsAtEval: null,
    }).severity;
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

describe('ingestDispatchEvent -- real outcomes (spec 2026-09-30 sections 3, 6, 7)', () => {
  function notify(toolUseId: string, endedAtMs: number, body: string) {
    return { ...completionEvent(toolUseId, endedAtMs), humanText: `<tool-use-id>${toolUseId}</tool-use-id>${body}` };
  }
  const quiet = () => ({ diag: () => {}, reportedStatusTags: new Set<string>() });

  it('failed -> exit_state error, severity 4, NULL usage columns', () => {
    const db = freshDb();
    expect(ingestDispatchEvent(db, openDispatch('tu_f', 1000), notify('tu_f', 9000, '<status>failed</status>'), quiet())).toBe(true);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_f');
    expect(row).toMatchObject({ exit_state: 'error', severity: 4, tokens: null, tool_uses: null, duration_ms: null });
    db.close();
  });

  it('killed -> exit_state killed, severity 2, NULL usage columns', () => {
    const db = freshDb();
    ingestDispatchEvent(db, openDispatch('tu_k', 1000), notify('tu_k', 9000, '<status>killed</status>'), quiet());
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_k');
    expect(row).toMatchObject({ exit_state: 'killed', severity: 2, tokens: null, tool_uses: null, duration_ms: null });
    db.close();
  });

  it('unrecognised status -> ok/1 and exactly one diag line per unseen value', () => {
    const db = freshDb();
    const lines: string[] = [];
    const opts = { diag: (l: string) => lines.push(l), reportedStatusTags: new Set<string>() };
    ingestDispatchEvent(db, openDispatch('tu_r1', 1000), notify('tu_r1', 2000, '<status>running</status>'), opts);
    ingestDispatchEvent(db, openDispatch('tu_r2', 1000), notify('tu_r2', 2000, '<status>running</status>'), opts);
    const row: any = db.prepare('SELECT exit_state, severity FROM dispatches WHERE tool_use_id = ?').get('tu_r1');
    expect(row).toEqual({ exit_state: 'ok', severity: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tag=running');
    db.close();
  });

  it('uses the collector history median: slow completion after 5 prior successes -> 2, median recorded', () => {
    const db = freshDb();
    const opts = quiet();
    const usage = (d: number) => `<status>completed</status><subagent_tokens>10</subagent_tokens><tool_uses>1</tool_uses><duration_ms>${d}</duration_ms>`;
    [1000, 1000, 1000, 1000, 1000].forEach((d, i) => {
      const id = `tu_p${i}`;
      ingestDispatchEvent(db, openDispatch(id, 100 * i), notify(id, 100 * i + 50, usage(d)), opts);
    });
    ingestDispatchEvent(db, openDispatch('tu_slow', 9000), notify('tu_slow', 99999, usage(3001)), opts);
    const row: any = db.prepare('SELECT severity, median_ms_at_eval FROM dispatches WHERE tool_use_id = ?').get('tu_slow');
    expect(row).toEqual({ severity: 2, median_ms_at_eval: 1000 });
    db.close();
  });

  it('the median query ignores duration_ms = 0 and NULL rows and non-ok rows', () => {
    const db = freshDb();
    const ins = db.prepare(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, exit_state)
                            VALUES (?, 0, 0, ?, 0, ?, 'general-purpose', 'general-purpose', ?)`);
    for (let i = 0; i < 10; i++) ins.run(`z${i}`, 0, i, 'ok');
    for (let i = 0; i < 4; i++) ins.run(`g${i}`, 500, 100 + i, 'ok');
    ins.run('e0', 99999, 200, 'error');
    expect(medianDurationMsFor(db, 'general-purpose', 'none')).toBeNull();
    ins.run('g4', 500, 300, 'ok');
    expect(medianDurationMsFor(db, 'general-purpose', 'none')).toBe(500);
    expect(medianDurationMsFor(db, null, 'none')).toBeNull();
    db.close();
  });

  it('a late completion replaces a fatal (stalled) row', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, exit_state, severity)
                VALUES ('tu_late', NULL, NULL, 1800001, 1000, 1801001, 'fatal', 4)`).run();
    ingestDispatchEvent(db, openDispatch('tu_late', 1000), notify('tu_late', 1900000, '<status>completed</status><subagent_tokens>5</subagent_tokens><tool_uses>2</tool_uses><duration_ms>1899000</duration_ms>'), quiet());
    const row: any = db.prepare('SELECT exit_state, severity, duration_ms FROM dispatches WHERE tool_use_id = ?').get('tu_late');
    expect(row).toEqual({ exit_state: 'ok', severity: 1, duration_ms: 1899000 });
    db.close();
  });
});
