// Bounded, pull-based transcript read path for the Comms Deck (Stage 14, Task 1).
//
// On-disk layout finding (required by the task brief, verified against real
// transcripts on this machine before writing any code below):
//
//   ~/.claude/projects/<projectDirName>/<sessionId>.jsonl        -- the main session
//   ~/.claude/projects/<projectDirName>/<sessionId>/subagents/
//       agent-<agentId>.jsonl                                    -- one subagent's own
//                                                                    conversation
//       agent-<agentId>.meta.json                                -- { agentType,
//                                                                    description,
//                                                                    toolUseId,
//                                                                    spawnDepth, model }
//
// A subagent dispatch's conversation is a SEPARATE, separately-addressable file (not
// interleaved into the parent transcript, and not merely absent from disk). It is
// nested under a directory named after the parent session's id, with an isSidechain:
// true marker on its own lines and a sibling .meta.json describing the dispatch
// (agentType/description double as a human-readable label). This was confirmed by
// inspecting this app's own recently-dispatched subagent files under
// ~/.claude/projects/C--Users-Matt-projects-TokenMonitor/<sessionId>/subagents/ while
// writing this module -- one of those subagent files is, recursively, the transcript of
// the very agent that wrote this comment. Per the design doc's Known Limitation #2, this
// means dispatch channels get their OWN source entry (kind: 'dispatch'), not a filtered
// window on the parent.
//
// This module is deliberately separate from transcriptParser.ts. It consumes
// parseTranscriptLine's output for the fields that module already extracts (tool uses,
// tool results, human-prompt text, origin kind) but does NOT widen that parser's
// contract. TranscriptEvent has no field for assistant response text or a per-line
// message id -- those are display-only concerns transcriptParser.ts was never asked to
// carry, and liveAgentTracker.ts / liveAgentsMath.ts (transcriptParser's real consumers)
// don't need them. Rather than growing TranscriptEvent for a single new caller, this
// module does one extra, narrowly-scoped JSON.parse of the same already-validated line
// (parseTranscriptLine returning non-null already proved it's parseable JSON) to pull
// `uuid` and the raw text content items straight from the source line. Nothing here is
// written to `TranscriptEvent` or fed back into the parser's contract.
//
// Read/store discipline: every function below returns data, it never caches transcript
// content anywhere persistent. Callers (main.ts's ipcMain.handle registrations) must not
// push this on a tick or store it -- see the comment at the IPC registration site.

import { promises as fsp } from 'fs';
import path from 'path';
import { parseTranscriptLine } from './transcriptParser';
import { labelForToolUse } from '../src/state/liveAgentsMath';

export interface DisplayMessage {
  id: string;
  role: 'human' | 'assistant' | 'system';
  atMs: number;
  text: string | null;
  toolCalls: { name: string; label: string }[];
  toolResults: { resultLength: number }[];
}

export interface TranscriptSource {
  id: string;
  kind: 'session' | 'dispatch';
  label: string;
  isLive: boolean;
}

const CHUNK_SIZE = 64 * 1024;
const LIVE_WINDOW_MS = 30_000;
const NEWLINE_BYTE = 0x0a;

interface LineWithOffset {
  text: string;
  startOffset: number;
}

/**
 * Reads up to `limit` complete lines from the end of `filePath`, walking
 * backward in fixed-size chunks so a multi-megabyte transcript never gets
 * fully loaded into memory. `beforeOffset`, if given, is the byte offset of
 * an earlier read's oldest line -- passing it back in continues the tail
 * further toward the start of the file ("load older"). Splitting happens in
 * Buffer space on the raw 0x0A byte (never a UTF-8 continuation byte), so
 * decoding to a JS string only happens once per already-complete line --
 * chunk boundaries can never land mid multi-byte character.
 */
async function readTailLines(filePath: string, limit: number, beforeOffset?: number): Promise<LineWithOffset[]> {
  const stat = await fsp.stat(filePath);
  let pos = beforeOffset !== undefined ? Math.min(beforeOffset, stat.size) : stat.size;
  const collected: LineWithOffset[] = [];
  let pendingTail = Buffer.alloc(0);

  const fd = await fsp.open(filePath, 'r');
  try {
    while (pos > 0 && collected.length < limit) {
      const readSize = Math.min(CHUNK_SIZE, pos);
      const start = pos - readSize;
      const buf = Buffer.alloc(readSize);
      await fd.read(buf, 0, readSize, start);
      const combined = Buffer.concat([buf, pendingTail]);

      const localLines: LineWithOffset[] = [];
      let searchEnd = combined.length;
      let idx: number;
      while (
        collected.length + localLines.length < limit &&
        (idx = combined.lastIndexOf(NEWLINE_BYTE, searchEnd - 1)) !== -1
      ) {
        const lineBuf = combined.subarray(idx + 1, searchEnd);
        if (lineBuf.length > 0) {
          localLines.unshift({ text: lineBuf.toString('utf8'), startOffset: start + idx + 1 });
        }
        searchEnd = idx;
      }

      pendingTail = combined.subarray(0, searchEnd);
      collected.unshift(...localLines);
      pos = start;

      if (pos === 0 && pendingTail.length > 0 && collected.length < limit) {
        collected.unshift({ text: pendingTail.toString('utf8'), startOffset: 0 });
        pendingTail = Buffer.alloc(0);
      }
    }
  } finally {
    await fd.close();
  }

  return collected.length > limit ? collected.slice(collected.length - limit) : collected;
}

function toDisplayMessage(line: string, startOffset: number): DisplayMessage | null {
  const event = parseTranscriptLine(line);
  if (!event) return null;

  // Safe: parseTranscriptLine already proved this line is valid JSON.
  let raw: any = {};
  try {
    raw = JSON.parse(line.trim());
  } catch {
    raw = {};
  }

  const id: string = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : `offset-${startOffset}`;
  const atMs = event.timestamp ? event.timestamp.getTime() : 0;

  let role: DisplayMessage['role'] = 'system';
  let text: string | null = null;

  if (event.kind === 'assistant') {
    role = 'assistant';
    const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const textItem = content.find((item: any) => item && item.type === 'text');
    text = textItem ? textItem.text : null;
  } else if (event.kind === 'user') {
    role = event.isHumanPrompt ? 'human' : 'system';
    text = event.humanText;
  }

  const toolCalls = event.toolUses.map((tu) => ({ name: tu.name, label: labelForToolUse(tu.name, tu.input) }));
  const toolResults = event.toolResults.map((tr) => ({ resultLength: tr.resultLength }));

  return { id, role, atMs, text, toolCalls, toolResults };
}

/**
 * Bounded tail read of a single transcript file, in display order (oldest
 * first). `before` is the byte offset of the oldest message from a prior
 * read (its numeric string form), used to page further back.
 */
export async function readTranscript(
  filePath: string,
  opts: { limit: number; before?: string }
): Promise<DisplayMessage[]> {
  const beforeOffset = opts.before !== undefined ? Number(opts.before) : undefined;
  const lines = await readTailLines(filePath, opts.limit, Number.isFinite(beforeOffset) ? beforeOffset : undefined);

  const messages: DisplayMessage[] = [];
  for (const { text, startOffset } of lines) {
    const msg = toDisplayMessage(text, startOffset);
    if (msg) messages.push(msg);
  }
  return messages;
}

async function isLive(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return Date.now() - stat.mtimeMs < LIVE_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Resolves a TranscriptSource id (as returned by listTranscriptSources) back
 * to an absolute file path. Session ids resolve directly under sessionDir;
 * dispatch ids are `dispatch:<parentSessionId>:<agentFileBase>` and resolve
 * under `<sessionDir>/<parentSessionId>/subagents/`.
 */
export function resolveSourcePath(sessionDir: string, sourceId: string): string {
  if (sourceId.startsWith('dispatch:')) {
    const [, parentId, agentBase] = sourceId.split(':');
    return path.join(sessionDir, parentId, 'subagents', `${agentBase}.jsonl`);
  }
  return path.join(sessionDir, `${sourceId}.jsonl`);
}

/**
 * Enumerates the pinned/active session plus any separately-addressable
 * dispatch transcripts nested under it. Returns [] if there is no pinned
 * session yet (nothing to read).
 */
export async function listTranscriptSources(
  sessionDir: string,
  pinnedSessionId: string | null
): Promise<TranscriptSource[]> {
  if (!pinnedSessionId) return [];

  const sources: TranscriptSource[] = [];
  const sessionFile = path.join(sessionDir, `${pinnedSessionId}.jsonl`);
  sources.push({ id: pinnedSessionId, kind: 'session', label: 'Session', isLive: await isLive(sessionFile) });

  const subagentsDir = path.join(sessionDir, pinnedSessionId, 'subagents');
  let entries: string[] = [];
  try {
    entries = (await fsp.readdir(subagentsDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    entries = [];
  }

  for (const file of entries) {
    const base = path.basename(file, '.jsonl');
    const filePath = path.join(subagentsDir, file);
    let label = base;
    try {
      const metaRaw = await fsp.readFile(path.join(subagentsDir, `${base}.meta.json`), 'utf8');
      const meta = JSON.parse(metaRaw);
      label = meta.description || meta.agentType || base;
    } catch {
      // No meta file, or malformed -- fall back to the file's own basename.
    }
    sources.push({ id: `dispatch:${pinnedSessionId}:${base}`, kind: 'dispatch', label, isLive: await isLive(filePath) });
  }

  return sources;
}
