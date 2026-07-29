import type { DatabaseSync } from 'node:sqlite';
import { relative, isAbsolute } from 'node:path';
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

// filePath is what toolCallHistory.ts's extractFilePath pulled verbatim from
// the tool_use input (an absolute path in the real Electron/collector
// runtime). Only absolute paths are converted via path.relative + an
// escape check (docs/privacy-and-data.md SS5: never persist a path
// containing the home dir/username); a filePath that's already relative
// (as constructed directly by callers/tests) is passed through unchanged
// rather than being incorrectly re-resolved against projectRoot.
function toProjectRelative(filePath: string | null, projectRoot: string): string | null {
  if (filePath === null) return null;
  if (!isAbsolute(filePath)) return filePath;
  try {
    const rel = relative(projectRoot, filePath);
    return rel.startsWith('..') ? null : rel;
  } catch {
    return null;
  }
}

export function ingestToolCallsAndAnomalies(
  db: DatabaseSync,
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
  projectRoot: string,
): { history: ToolCallHistory; toolCallsIngested: number; anomaliesIngested: number } {
  const before = history.events.length;
  const newHistory = updateHistory(history, events, nowMs);
  const newlyClosed = newHistory.events.slice(before === newHistory.events.length ? newHistory.events.length : before);

  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES (?, ?, ?, ?, ?)`
  );
  for (const call of newlyClosed) {
    insertToolCall.run(call.toolUseId, call.toolName, toProjectRelative(call.filePath, projectRoot), call.startedAt, call.closedAt);
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
  const insertAnomaly = db.prepare(
    `INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)`
  );
  for (const a of anomalies) {
    insertAnomaly.run(a.kind, a.toolUseId, a.detail, nowMs);
  }

  return { history: newHistory, toolCallsIngested: newlyClosed.length, anomaliesIngested: anomalies.length };
}
