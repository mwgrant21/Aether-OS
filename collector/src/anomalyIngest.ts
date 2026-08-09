import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';
import { type ToolCallHistory, type ClosedToolCall, updateHistory } from './toolCallHistory.js';

export interface Anomaly {
  kind: 'reReadLoop' | 'writeDeleteRewrite' | 'zeroEditBurn';
  toolUseId: string;
  detail: string;
}

function detectReReadLoop(events: ClosedToolCall[]): Anomaly[] {
  const byPath = new Map<string, ClosedToolCall[]>();
  for (const event of events) {
    if (event.toolName === 'Read' && event.filePath !== null) {
      if (!byPath.has(event.filePath)) byPath.set(event.filePath, []);
      byPath.get(event.filePath)!.push(event);
    }
  }
  const anomalies: Anomaly[] = [];
  for (const [filePath, reads] of byPath.entries()) {
    if (reads.length >= 3) {
      const mostRecent = reads.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({ kind: 'reReadLoop', toolUseId: mostRecent.toolUseId, detail: `${filePath} read ${reads.length} times` });
    }
  }
  return anomalies;
}

function detectWriteDeleteRewrite(events: ClosedToolCall[], nowMs: number): Anomaly[] {
  const windowStart = nowMs - 300000;
  const byPath = new Map<string, ClosedToolCall[]>();
  for (const event of events) {
    if ((event.toolName === 'Write' || event.toolName === 'Edit') && event.filePath !== null && event.closedAt >= windowStart) {
      if (!byPath.has(event.filePath)) byPath.set(event.filePath, []);
      byPath.get(event.filePath)!.push(event);
    }
  }
  const anomalies: Anomaly[] = [];
  for (const [filePath, writes] of byPath.entries()) {
    if (writes.length >= 3) {
      const mostRecent = writes.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({ kind: 'writeDeleteRewrite', toolUseId: mostRecent.toolUseId, detail: `${filePath} written ${writes.length} times in 5min` });
    }
  }
  return anomalies;
}

function detectZeroEditBurn(events: ClosedToolCall[], tokensUsed: number): Anomaly[] {
  if (tokensUsed < 20000) return [];
  const hasEdits = events.some((e) => e.toolName === 'Write' || e.toolName === 'Edit' || e.toolName === 'NotebookEdit');
  if (!hasEdits) {
    return [{ kind: 'zeroEditBurn', toolUseId: '', detail: `${tokensUsed} tokens used with zero file edits` }];
  }
  return [];
}

export function ingestToolCallsAndAnomalies(
  db: DatabaseSync,
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
  sourceFileRel: string,
): { history: ToolCallHistory; toolCallsIngested: number; anomaliesIngested: number } {
  const newHistory = updateHistory(history, events, nowMs);
  // Diff by toolUseId membership rather than array index/length: once
  // HISTORY_MAX_EVENTS truncation kicks in (toolCallHistory.ts's
  // updateHistory trims oldest-first), newHistory.events.length can be equal
  // to or even less than history.events.length even though new closures
  // happened this tick, so an index-based slice would either re-persist
  // already-inserted tool calls as duplicates or silently miss new ones.
  const priorToolUseIds = new Set(history.events.map((e) => e.toolUseId));
  const newlyClosed = newHistory.events.filter((e) => !priorToolUseIds.has(e.toolUseId));

  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const call of newlyClosed) {
    // call.filePath is already project-relative-or-null by construction:
    // toolCallHistory.ts sanitizes it against the event's own cwd the moment
    // it enters the history, so no per-call-site sanitization is needed here
    // (and, critically, none can be forgotten in the anomaly `detail`
    // builders either). See toProjectRelative's doc comment.
    insertToolCall.run(call.toolUseId, call.toolName, call.filePath, call.startedAt, call.closedAt, sourceFileRel);
  }

  const recentWindow = newHistory.events.filter((e) => e.closedAt >= nowMs - 300000);
  const anomalies = [
    ...detectReReadLoop(recentWindow),
    ...detectWriteDeleteRewrite(recentWindow, nowMs),
    // detectZeroEditBurn is called with tokensUsed: 0 here deliberately --
    // this ingestion pass has no access to a per-window token total (that's
    // computed separately from usage_events in Task 7's Optimize rule, the
    // one place detectZeroEditBurn genuinely needs live token counts).
    // Wiring a real tokensUsed into the collector's own anomaly persistence
    // is out of scope for this task; this branch will not fire until a
    // follow-up threads token totals through, and that limitation is
    // intentional, not silently dropped.
    ...detectZeroEditBurn(recentWindow, 0),
  ];
  // The detectors re-scan a rolling 5-minute window on EVERY scan tick
  // (~15s), so one genuine anomaly is re-detected on ~20 consecutive ticks.
  // The unique index on anomalies(kind, tool_use_id) plus OR IGNORE collapses
  // those to a single persisted row instead of ~20 duplicate timeline
  // entries. anomaliesIngested therefore counts rows actually inserted.
  const insertAnomaly = db.prepare(
    `INSERT OR IGNORE INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)`
  );
  let anomaliesIngested = 0;
  for (const a of anomalies) {
    const info = insertAnomaly.run(a.kind, a.toolUseId, a.detail, nowMs);
    if (Number(info.changes) > 0) anomaliesIngested += 1;
  }

  return { history: newHistory, toolCallsIngested: newlyClosed.length, anomaliesIngested };
}
