import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseTranscriptLine } from './transcriptParser.js';
import { stampTranscriptScanHeartbeat } from './schema.js';
import { ingestUsageEvent, ingestDispatchEvent } from './usageIngest.js';
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory, type ToolCallHistory } from './toolCallHistory.js';
import { sweepStaleDispatches } from './staleDispatchSweep.js';

function getLastOffset(db: DatabaseSync, filePath: string): number {
  const row = db.prepare('SELECT last_offset FROM transcript_files WHERE file_path = ?').get(filePath) as
    | { last_offset: number }
    | undefined;
  return row ? row.last_offset : 0;
}

function recordOffset(db: DatabaseSync, filePath: string, offset: number, nowMs: number): void {
  db.prepare(
    `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
  ).run(filePath, offset, nowMs);
}

// readNewLines (transcriptTailer.ts) is async (uses fsp.open/fd.read); this
// orchestrator's own test suite and the collector's poll loop are both fine
// awaiting it, but a synchronous wrapper keeps this function's own signature
// synchronous and simple to test/call from a plain setInterval tick without
// threading async/await through every caller. Uses the synchronous fs API
// directly rather than calling the async readNewLines, to avoid mixing sync
// directory walking with async file reads in the same loop.
function readNewLinesSync(filePath: string, offset: number): { lines: string[]; newOffset: number } {
  const stat = statSync(filePath);
  if (stat.size <= offset) return { lines: [], newOffset: offset };

  const length = stat.size - offset;
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], newOffset: offset };
    const complete = text.slice(0, lastNewline);
    const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    return { lines: complete.split('\n'), newOffset };
  } finally {
    closeSync(fd);
  }
}

export function scanTranscriptsOnce(
  db: DatabaseSync,
  projectsRoot: string,
  nowMs: number,
  historyByFile: Map<string, ToolCallHistory>
): { filesScanned: number; eventsIngested: number; toolCallsIngested: number; anomaliesIngested: number } {
  // Stamped first and unconditionally: the heartbeat proves the scan cycle is
  // alive, not that it succeeded (see stampTranscriptScanHeartbeat), so the
  // unreadable-projects-root early return below must not skip it.
  stampTranscriptScanHeartbeat(db, nowMs);

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { filesScanned: 0, eventsIngested: 0, toolCallsIngested: 0, anomaliesIngested: 0 };
  }

  let filesScanned = 0;
  let eventsIngested = 0;
  let toolCallsIngested = 0;
  let anomaliesIngested = 0;

  for (const dirName of projectDirs) {
    const dirPath = join(projectsRoot, dirName);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      // filePath is absolute and used for all actual filesystem operations
      // (statSync/openSync/readSync below); relativePath is what's stored in
      // (and looked up from) the transcript_files table, per
      // docs/privacy-and-data.md SS5 -- that table must never persist a path
      // containing the home directory/username.
      const filePath = join(dirPath, file);
      const relativePath = join(dirName, file);
      const offset = getLastOffset(db, relativePath);
      let lines: string[];
      let newOffset: number;
      try {
        const result = readNewLinesSync(filePath, offset);
        lines = result.lines;
        newOffset = result.newOffset;
      } catch {
        continue;
      }

      const parsedEvents = lines
        .map((l) => parseTranscriptLine(l))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      for (const event of parsedEvents) {
        if (ingestUsageEvent(db, event)) eventsIngested += 1;
      }

      const priorHistory = historyByFile.get(relativePath) ?? createEmptyHistory();
      const anomalyResult = ingestToolCallsAndAnomalies(db, priorHistory, parsedEvents, nowMs);
      historyByFile.set(relativePath, anomalyResult.history);
      toolCallsIngested += anomalyResult.toolCallsIngested;
      anomaliesIngested += anomalyResult.anomaliesIngested;

      // Dispatch (Agent subagent) completion. ingestDispatchEvent applies its
      // own guards and no-ops unless the event is a genuine 'user'-kind
      // 'task-notification' carrying a <tool-use-id> that matches a still-open
      // 'Agent' tool call, so it is simply offered every parsed event -- no
      // loop over openByToolUseId, which is what previously fanned one
      // completion out across every open dispatch.
      // anomalyResult.history (not priorHistory) is used so an Agent tool_use
      // and its completion arriving in the same scan tick still correlate --
      // updateHistory never closes an Agent entry via a normal tool_result, so
      // the open entry survives into anomalyResult.history either way.
      for (const event of parsedEvents) {
        ingestDispatchEvent(db, anomalyResult.history, event);
      }

      // Fatal-via-staleness sweep: run after the above ingest work so it sees
      // this tick's freshest history (an Agent open entry that just closed via
      // ingestDispatchEvent above is no longer in anomalyResult.history and
      // will not be swept).
      sweepStaleDispatches(db, anomalyResult.history, nowMs);

      filesScanned += 1;
      recordOffset(db, relativePath, newOffset, nowMs);
    }
  }

  return { filesScanned, eventsIngested, toolCallsIngested, anomaliesIngested };
}
