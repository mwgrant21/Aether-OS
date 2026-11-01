import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseTranscriptLine, type TranscriptEvent } from './transcriptParser.js';
import { stampTranscriptScanHeartbeat } from './schema.js';
import { ingestUsageEvent, ingestDispatchEvent, rescorePendingDispatches } from './usageIngest.js';
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory, type ToolCallHistory } from './toolCallHistory.js';
import { sweepStaleDispatches } from './staleDispatchSweep.js';
import { extractDispatchResultText } from './dispatchResultText.js';
import type { MemoryExtractQueue } from './memoryExtractQueue.js';
import { createSubagentLinkIndex, type SubagentFileProbe } from './severity/subagentLink.js';
import { parseDispatchOutcome } from './severity/parseDispatchOutcome.js';

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

// docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md SS4.
// Trivial one-shot dispatches are unlikely to produce a judgment worth
// remembering; this keeps claude -p spawn frequency proportional to
// substantive work. Not tuned against real traffic -- revisit once this has
// run for a while, same caveat as the Layer 2 spec's own Phase E.
function clearsExtractionBar(durationMs: number, toolUses: number): boolean {
  return durationMs >= 60_000 || toolUses >= 5;
}

// Runs fn in one transaction, so a file's usage rows, tool calls, dispatch
// rows and offset land together or not at all: a failure never leaves the
// offset past rows that were not written, and a retry never double-counts
// usage_events (no unique key). Kept per file, with the transcript read done
// before it opens: collector.db has a second writable handle
// (electron/retentionStore.ts) with a 5s busy_timeout, which a pass-wide
// transaction over a cold scan would outlast.
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// The subagent tool-error counts ingestDispatchEvent consults (completed runs
// only), read before the file's transaction opens so it never waits on a
// subagent transcript read.
function resolveToolErrors(notifications: readonly TranscriptEvent[], probe: SubagentFileProbe): (id: string) => number | null {
  const counts = new Map<string, number | null>();
  for (const event of notifications) {
    const text = event.humanText || '';
    const id = text.match(/<tool-use-id>(.*?)<\/tool-use-id>/)?.[1];
    if (id === undefined || counts.has(id) || parseDispatchOutcome(text).status !== 'completed') continue;
    counts.set(id, probe.toolErrorsFor(id));
  }
  return (id) => counts.get(id) ?? null;
}

export function scanTranscriptsOnce(
  db: DatabaseSync,
  projectsRoot: string,
  nowMs: number,
  historyByFile: Map<string, ToolCallHistory>,
  extractQueue?: MemoryExtractQueue,
  ownSessionId: string | null = null
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

  // One parent/subagent index per scan pass: a dispatch's subagent files can
  // live under a different project dir than its parent transcript, and this
  // keeps that lookup from rescanning every project dir per dispatch.
  const linkIndex = createSubagentLinkIndex(projectsRoot);

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
      const sessionBase = file.replace(/\.jsonl$/, '');
      const subagentProbe = linkIndex.probeFor(sessionBase);
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

      const priorHistory = historyByFile.get(relativePath) ?? createEmptyHistory();
      // Idle fast path: a file with no new bytes and no open Agent entry has
      // nothing to parse, ingest or sweep, and its offset is already recorded, so
      // opening a transaction (a synchronous=FULL commit, ~20 ms) would only
      // rewrite last_scanned_ms, which nothing reads. A file with an open Agent
      // entry runs only the staleness sweep (below), which must still fire on a
      // later tick with no new bytes.
      const noNewBytes = lines.length === 0 && newOffset === offset;
      const hasOpenAgent = Object.values(priorHistory.openByToolUseId).some((o) => o.toolName === 'Agent');
      const idle = noNewBytes && !hasOpenAgent;
      if (noNewBytes && hasOpenAgent) {
        // Idle with an open Agent entry: only the staleness sweep can change
        // anything. Nothing was parsed, so the history and offset are unchanged
        // (no historyByFile.set, no recordOffset), and the sweep skips entries
        // that already have a dispatches row and writes a stale one as a single
        // autocommit upsert, so no transaction is needed. An async-launched Agent
        // entry stays open (the launch ack does not close it), so these files
        // would otherwise pay a synchronous=FULL commit every tick.
        sweepStaleDispatches(db, priorHistory, nowMs, (id) => subagentProbe.lastWriteMsFor(id), ownSessionId);
        filesScanned += 1;
      } else if (!idle) {
        const parsedEvents = lines
          .map((l) => parseTranscriptLine(l))
          .filter((e): e is NonNullable<typeof e> => e !== null);
        const notifications = parsedEvents.filter((e) => e.originKind === 'task-notification');
        const toolErrorsFor = resolveToolErrors(notifications, subagentProbe);

        const { anomalyResult, usageCount } = inTransaction(db, () => {
          let usage = 0;
          for (const event of parsedEvents) {
            if (ingestUsageEvent(db, event, relativePath)) usage += 1;
          }
          const result = ingestToolCallsAndAnomalies(db, priorHistory, parsedEvents, nowMs, relativePath);

          // Dispatch (Agent subagent) completion. ingestDispatchEvent applies its
          // own guards and no-ops unless the event is a genuine 'user'-kind
          // 'task-notification' carrying a <tool-use-id> that matches a still-open
          // 'Agent' tool call, so it is simply offered every task-notification --
          // no loop over openByToolUseId, which is what previously fanned one
          // completion out across every open dispatch.
          // result.history (not priorHistory) is used so an Agent tool_use
          // and its completion arriving in the same scan tick still correlate --
          // updateHistory keeps an Agent entry open on the async-launch
          // acknowledgement, so the open entry survives into result.history either
          // way; ingestDispatchEvent removes it once the completion is stored.
          for (const event of notifications) {
            ingestDispatchEvent(db, result.history, event, { toolErrorsFor });
          }

          // Fatal-via-staleness sweep: run after the above ingest work so it sees
          // this tick's freshest history. ingestDispatchEvent removes the entry
          // of a dispatch it just completed from result.history.openByToolUseId, so
          // the sweep below is not offered it. The existing-row guard inside
          // sweepStaleDispatches (in staleDispatchSweep.ts) stays load-bearing for
          // sweep-stamped fatal rows whose entry is still open. ownSessionId (the pin, read fresh by the caller each scan) exempts the
          // pinned session from the not-in-fleet_sessions test. Its progress probe only stats subagent files of
          // dispatches that have no row yet.
          sweepStaleDispatches(db, result.history, nowMs, (id) => subagentProbe.lastWriteMsFor(id), ownSessionId);
          recordOffset(db, relativePath, newOffset, nowMs);
          return { anomalyResult: result, usageCount: usage };
        });
        historyByFile.set(relativePath, anomalyResult.history);
        eventsIngested += usageCount;
        toolCallsIngested += anomalyResult.toolCallsIngested;
        anomaliesIngested += anomalyResult.anomaliesIngested;
        filesScanned += 1;

        // Memory Layer 2 wiring (docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md
        // SS2). extractQueue is optional so every existing caller (including this
        // file's own tests) is unaffected when omitted -- extraction is simply
        // skipped. Reads event.humanText (already parsed, already in memory for
        // this scan tick), never re-opens the file and never persists the text
        // anywhere.
        if (extractQueue) {
          for (const event of parsedEvents) {
            if (event.originKind !== 'task-notification') continue;
            const idMatch = (event.humanText || '').match(/<tool-use-id>(.*?)<\/tool-use-id>/);
            if (!idMatch) continue;
            const toolUseId = idMatch[1];

            const row = db
              .prepare(
                'SELECT agent_id, task_kind, session_id, duration_ms, tool_uses, exit_state FROM dispatches WHERE tool_use_id = ?',
              )
              .get(toolUseId) as
              | { agent_id: string | null; task_kind: string | null; session_id: string | null; duration_ms: number | null; tool_uses: number | null; exit_state: string }
              | undefined;
            if (!row || !row.agent_id) continue;
            if (row.exit_state !== 'ok') continue;
            if (row.duration_ms === null || row.tool_uses === null) continue;
            if (!clearsExtractionBar(row.duration_ms, row.tool_uses)) continue;

            const runSummary = extractDispatchResultText(event.humanText);
            if (!runSummary) continue;

            extractQueue.push({
              agentId: row.agent_id,
              taskKind: row.task_kind ?? row.agent_id,
              sessionId: row.session_id,
              toolUseId,
              runSummary,
              queuedAtMs: nowMs,
            });
          }
        }

      }
      // Subagent dispatch transcripts (Stage-5-era gap, closed here): each
      // dispatch's own tool calls live in a separate file this loop
      // otherwise never visits. See the reconciliation note §1.
      const subagentsDir = join(dirPath, sessionBase, 'subagents');
      let subagentFiles: string[];
      try {
        subagentFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        subagentFiles = [];
      }
      for (const subFile of subagentFiles) {
        const subFilePath = join(subagentsDir, subFile);
        const subRelativePath = join(dirName, sessionBase, 'subagents', subFile);
        const subOffset = getLastOffset(db, subRelativePath);
        let subLines: string[];
        let subNewOffset: number;
        try {
          const subResult = readNewLinesSync(subFilePath, subOffset);
          subLines = subResult.lines;
          subNewOffset = subResult.newOffset;
        } catch {
          continue;
        }
        // Idle subagent file: nothing new to ingest, and nested histories are never
        // swept (see below), so skip the transaction and the offset rewrite.
        if (subLines.length === 0 && subNewOffset === subOffset) continue;
        const subParsedEvents = subLines.map((l) => parseTranscriptLine(l)).filter((e): e is NonNullable<typeof e> => e !== null);

        // A dispatched subagent's assistant turns carry their own token usage,
        // and this loop previously ingested only tool calls and anomalies from
        // them -- so every dispatch's own spend was missing from usage_events,
        // exactly the workload Cost Forensics exists to measure. Mirrors the
        // top-level loop above; ingestUsageEvent is idempotent per event, so a
        // re-scan of an already-recorded turn does not double count.
        // See issue #25.
        const subNotifications = subParsedEvents.filter((e) => e.originKind === 'task-notification');
        const subToolErrorsFor = resolveToolErrors(subNotifications, subagentProbe);
        const subPriorHistory = historyByFile.get(subRelativePath) ?? createEmptyHistory();

        const sub = inTransaction(db, () => {
          let usage = 0;
          for (const event of subParsedEvents) {
            if (ingestUsageEvent(db, event, subRelativePath)) usage += 1;
          }
          const result = ingestToolCallsAndAnomalies(db, subPriorHistory, subParsedEvents, nowMs, subRelativePath);

          // Nested (spawnDepth-2) dispatches: the Agent tool_use and its
          // task-notification sit in a subagent transcript. Record their outcome
          // here, but NEVER offer this history to sweepStaleDispatches: most
          // nested Agent calls close by tool_result, not task-notification, so
          // their entries stay open forever and a sweep would mark them all fatal.
          for (const event of subNotifications) {
            ingestDispatchEvent(db, result.history, event, { toolErrorsFor: subToolErrorsFor });
          }
          recordOffset(db, subRelativePath, subNewOffset, nowMs);
          return { anomalyResult: result, usageCount: usage };
        });
        historyByFile.set(subRelativePath, sub.anomalyResult.history);
        eventsIngested += sub.usageCount;
        toolCallsIngested += sub.anomalyResult.toolCallsIngested;
        anomaliesIngested += sub.anomalyResult.anomaliesIngested;
      }
    }
  }

  // Rescore (#106). Each completion was scored when its file was read, against
  // whatever rows existed then; on a first scan files arrive in readdirSync
  // order, not time order. Once the pass has stored them all, the durable
  // watermark ingestDispatchEvent keeps says which rows to rescore from the
  // database (see rescorePendingDispatches). Run every pass, not only when
  // this pass ingested something, so a watermark left by a crash or a failed
  // file is picked up on the next scan.
  inTransaction(db, () => rescorePendingDispatches(db));

  return { filesScanned, eventsIngested, toolCallsIngested, anomaliesIngested };
}
