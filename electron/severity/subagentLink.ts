// electron/severity/subagentLink.ts
// Links an Agent dispatch to its subagent transcript via
// <session>/subagents/agent-<id>.meta.json's toolUseId (spike note
// docs/superpowers/specs/2026-09-30-subagent-link-spike.md). Reads counts and
// mtimes only; no transcript text leaves this module. Never throws.
// meta.json is untrusted input: toolUseId must be a string, anything else is
// no link.
//
// SOURCE OF TRUTH for collector/src/severity/subagentLink.ts (generated).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SubagentFileProbe {
  toolErrorsFor(toolUseId: string): number | null;
  lastWriteMsFor(toolUseId: string): number | null;
}

export interface SubagentLinkIndex {
  /** Existing <project>/<sessionId>/subagents dirs, across ALL project dirs. */
  subagentsDirsFor(sessionId: string): string[];
  /** Probe over every subagents dir of the session (cross-project). */
  probeFor(sessionId: string): SubagentFileProbe;
}

export function toolUseIdFromSubagentMeta(metaJson: string): string | null {
  try {
    const id = (JSON.parse(metaJson) as { toolUseId?: unknown } | null)?.toolUseId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

const IS_ERROR_TRUE = /"is_error"\s*:\s*true/;

export function countToolErrors(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    // Cheap pre-filter: skip the JSON.parse for lines that cannot hold
    // is_error:true (the parse below still decides, so the count is unchanged).
    if (!line || !IS_ERROR_TRUE.test(line)) continue;
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } } | null)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'tool_result' && (item as { is_error?: unknown }).is_error === true) n += 1;
      }
    } catch {
      // malformed line: not an error signal
    }
  }
  return n;
}

const MAX_META_BYTES = 64 * 1024;

export function createSubagentFileProbe(subagentsDirs: string | readonly string[]): SubagentFileProbe {
  const dirs = typeof subagentsDirs === 'string' ? [subagentsDirs] : subagentsDirs;
  let index: Map<string, string> | null = null;
  function fileFor(toolUseId: string): string | null {
    if (index === null) {
      const built = new Map<string, string>();
      for (const dir of dirs) {
        let names: string[] = [];
        try {
          names = readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
        } catch {
          names = [];
        }
        for (const meta of names) {
          try {
            // meta.json is a few dozen bytes; a big one is not one of ours.
            if (statSync(join(dir, meta)).size > MAX_META_BYTES) continue;
            const id = toolUseIdFromSubagentMeta(readFileSync(join(dir, meta), 'utf8'));
            if (id && !built.has(id)) built.set(id, join(dir, meta.replace(/\.meta\.json$/, '.jsonl')));
          } catch {
            // unreadable meta: skip
          }
        }
      }
      index = built;
    }
    return index.get(toolUseId) ?? null;
  }
  return {
    toolErrorsFor(toolUseId) {
      const f = fileFor(toolUseId);
      if (!f) return null;
      try {
        return countToolErrors(readFileSync(f, 'utf8').split('\n'));
      } catch {
        return null;
      }
    },
    lastWriteMsFor(toolUseId) {
      const f = fileFor(toolUseId);
      if (!f) return null;
      try {
        return statSync(f).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Indexes <projectsRoot> once (one readdir per project dir, lazily on first
 * use): session id -> candidate subagents dirs. Build one per scan pass so a dispatch lookup never rescans
 * every project dir.
 */
export function createSubagentLinkIndex(projectsRoot: string): SubagentLinkIndex {
  let subDirs: Map<string, string[]> | null = null;
  const probes = new Map<string, SubagentFileProbe>();

  function build(): void {
    subDirs = new Map();
    let projects: string[] = [];
    try {
      projects = readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const proj of projects) {
      let entries: { name: string; isDirectory(): boolean }[] = [];
      try {
        entries = readdirSync(join(projectsRoot, proj), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          const list = subDirs.get(e.name) ?? [];
          list.push(join(projectsRoot, proj, e.name, 'subagents'));
          subDirs.set(e.name, list);
        }
      }
    }
  }

  function subagentsDirsFor(sessionId: string): string[] {
    if (subDirs === null) build();
    return (subDirs?.get(sessionId) ?? []).filter((d) => existsSync(d));
  }

  return {
    subagentsDirsFor,
    // Lazy: nothing is resolved or read until the first lookup, so a session
    // that never asks costs no filesystem access.
    probeFor(sessionId) {
      let p = probes.get(sessionId);
      if (p) return p;
      let inner: SubagentFileProbe | null = null;
      const get = (): SubagentFileProbe => (inner ??= createSubagentFileProbe(subagentsDirsFor(sessionId)));
      p = {
        toolErrorsFor: (id) => get().toolErrorsFor(id),
        lastWriteMsFor: (id) => get().lastWriteMsFor(id),
      };
      probes.set(sessionId, p);
      return p;
    },
  };
}
