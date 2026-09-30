// electron/severity/liveSubagentProgress.ts
// Live-path view of subagent transcripts: tool-error count (for the severity
// floor) and last-write time (for the stall check). Counts and timestamps only;
// nothing from a transcript leaves this module.
//
// Cost: the link index (one readdir per project dir under ~/.claude/projects)
// and the per-session meta.json index are built lazily, once per session, and
// reused on every later tick. They are rebuilt only when a lookup MISSES (the
// dispatch's meta.json may not exist yet) and then at most once per
// REFRESH_MS per session, so an unlinked dispatch does not rescan every tick.
// A hit costs one stat (progress) or one file read (errors, once, at
// completion).
//
// Live path only: NOT in scripts/sync-severity-core.mjs CORE_FILES.
import { createSubagentLinkIndex, type SubagentFileProbe } from './subagentLink';

export const PROBE_REFRESH_MS = 15_000;

export interface LiveSubagentProgress {
  toolErrorsFor(sessionId: string, toolUseId: string): number | null;
  lastWriteMsFor(sessionId: string, toolUseId: string): number | null;
}

export function createLiveSubagentProgress(projectsRoot: string, now: () => number = Date.now, refreshMs = PROBE_REFRESH_MS): LiveSubagentProgress {
  const sessions = new Map<string, { probe: SubagentFileProbe; builtAtMs: number }>();

  function build(sessionId: string): { probe: SubagentFileProbe; builtAtMs: number } {
    const entry = { probe: createSubagentLinkIndex(projectsRoot).probeFor(sessionId), builtAtMs: now() };
    sessions.set(sessionId, entry);
    return entry;
  }

  function lookup(sessionId: string, fn: (p: SubagentFileProbe) => number | null): number | null {
    let entry = sessions.get(sessionId) ?? build(sessionId);
    const hit = fn(entry.probe);
    if (hit !== null || now() - entry.builtAtMs < refreshMs) return hit;
    entry = build(sessionId);
    return fn(entry.probe);
  }

  return {
    toolErrorsFor: (sessionId, id) => lookup(sessionId, (p) => p.toolErrorsFor(id)),
    lastWriteMsFor: (sessionId, id) => lookup(sessionId, (p) => p.lastWriteMsFor(id)),
  };
}
