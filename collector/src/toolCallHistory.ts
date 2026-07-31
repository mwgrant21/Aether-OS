import { TranscriptEvent } from './transcriptParser.js';
import { relative, isAbsolute } from 'node:path';

// A relative path segment of exactly '..' (on either / or \ separators)
// indicates traversal outside whatever root the path is relative to.
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * Sanitizes a raw tool-input file path the moment it enters the history, so
 * that EVERY downstream consumer (the tool_calls INSERT, the anomaly
 * detectors and the `detail` strings they build) sees an already-relativized
 * path by construction, rather than each call site having to remember to
 * sanitize (docs/privacy-and-data.md SS5: never persist a path containing the
 * home directory/username).
 *
 * `projectRoot` is the transcript event's own `cwd` -- the working directory
 * of the Claude session that made the tool call, and the only root a real
 * absolute `file_path` is meaningfully relative to. (The transcript STORAGE
 * directory, previously passed here, shares no ancestor with the code working
 * tree, so relativizing against it yielded a '..'-laden path the guard below
 * correctly rejected -- i.e. a permanently NULL file_path_rel.)
 *
 * Absolute paths with no usable root, and any path that escapes the root, are
 * nulled rather than stored.
 */
export function toProjectRelative(filePath: string | null, projectRoot: string | null): string | null {
  if (filePath === null) return null;
  if (!isAbsolute(filePath)) {
    // Already-relative input (as constructed directly by callers/tests) is
    // passed through, but still traversal-checked so a crafted
    // '../../secret' can't slip past just because it never hit path.relative.
    return hasTraversalSegment(filePath) ? null : filePath;
  }
  if (projectRoot === null || projectRoot === '') return null;
  try {
    const rel = relative(projectRoot, filePath);
    if (rel === '') return null;
    // On win32, relative() between paths on different drives gives up and
    // returns the unchanged absolute `to` path (no '..' segments), so an
    // absolute result must be rejected the same as a traversal.
    if (isAbsolute(rel)) return null;
    return hasTraversalSegment(rel) ? null : rel;
  } catch {
    return null;
  }
}

export interface ClosedToolCall {
  toolUseId: string;
  toolName: string;
  filePath: string | null;
  startedAt: number;
  closedAt: number;
}

export interface ToolCallHistory {
  events: ClosedToolCall[];
  openByToolUseId: Record<string, { toolName: string; filePath: string | null; startedAt: number; subagentType: string | null; sessionId: string | null }>;
}

export const HISTORY_MAX_EVENTS = 500;

export function createEmptyHistory(): ToolCallHistory {
  return { events: [], openByToolUseId: {} };
}

export function updateHistory(
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
): ToolCallHistory {
  const newOpen = { ...history.openByToolUseId };
  let newEvents = [...history.events];

  for (const event of events) {
    for (const toolUse of event.toolUses) {
      // Sanitized here, at the single point a raw tool-input path enters the
      // history -- see toProjectRelative's doc comment.
      const filePath = toProjectRelative(extractFilePath(toolUse.input), event.cwd);
      const startedAt = event.timestamp?.getTime() ?? nowMs;
      const subagentType = extractSubagentType(toolUse.input);
      const sessionId = event.sessionId ?? null;
      newOpen[toolUse.id] = { toolName: toolUse.name, filePath, startedAt, subagentType, sessionId };
    }

    for (const toolResult of event.toolResults) {
      const open = newOpen[toolResult.toolUseId];
      if (open) {
        const closedAt = event.timestamp?.getTime() ?? nowMs;
        newEvents.push({
          toolUseId: toolResult.toolUseId,
          toolName: open.toolName,
          filePath: open.filePath,
          startedAt: open.startedAt,
          closedAt,
        });
        delete newOpen[toolResult.toolUseId];
      }
    }
  }

  if (newEvents.length > HISTORY_MAX_EVENTS) {
    newEvents = newEvents.slice(newEvents.length - HISTORY_MAX_EVENTS);
  }

  return { events: newEvents, openByToolUseId: newOpen };
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const filePath = obj.file_path;
  if (typeof filePath === 'string') return filePath;
  return null;
}

function extractSubagentType(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const subagentType = obj.subagent_type;
  if (typeof subagentType === 'string') return subagentType;
  return null;
}
