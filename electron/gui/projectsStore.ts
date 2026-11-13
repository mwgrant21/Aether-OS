import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomically } from '../atomicWrite';
import { GUI_MAX_PROJECTS } from './guiTypes';
import type { AddProjectResult, UiProject } from './guiTypes';

// Owner of ~/.aether-os/gui-projects.json: {"v":1,"projects":[{"id","path","addedAt"}]}.
// The one place Aether keeps absolute paths, by the user's choice. Paths stay in main: list() hands out
// {id,name} only, and pathOf(id) is for main-side callers. The file is user-writable, so loading is
// field-by-field and fails closed (a bad entry is dropped alone, a bad file reads as empty, nothing throws).
// On win32 a UNC or extended path (leading \ or //) is refused on add and on load: statting it can block on
// an unreachable share and leaks credentials to a planted host, and the path later becomes a launch cwd.
export const GUI_PROJECTS_FILE = 'gui-projects.json';
export const MAX_GUI_PROJECTS_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 1024;
const MAX_NAME_CHARS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Entry {
  path: string;
  addedAt: number;
}

const isUnc = (p: string): boolean => process.platform === 'win32' && (p.startsWith('\\') || p.startsWith('//'));
const dupKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
const nameOf = (p: string): string => (basename(p) || p).slice(0, MAX_NAME_CHARS);

function defaultIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function validPath(p: unknown): p is string {
  return (
    typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_CHARS && !p.includes('\0') && isAbsolute(p) && !isUnc(p)
  );
}

function load(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  try {
    const file = join(dir, GUI_PROJECTS_FILE);
    if (statSync(file).size > MAX_GUI_PROJECTS_BYTES) return out;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return out;
    const list = (raw as { projects?: unknown }).projects;
    if (!Array.isArray(list)) return out;
    const seen = new Set<string>();
    for (const e of list) {
      if (out.size >= GUI_MAX_PROJECTS) break;
      if (typeof e !== 'object' || e === null) continue;
      const { id, path, addedAt } = e as Record<string, unknown>;
      if (typeof id !== 'string' || !UUID_RE.test(id) || out.has(id)) continue;
      if (!validPath(path)) continue;
      if (typeof addedAt !== 'number' || !Number.isFinite(addedAt)) continue;
      const key = dupKey(resolve(path));
      if (seen.has(key)) continue;
      seen.add(key);
      out.set(id, { path, addedAt });
    }
  } catch {
    return new Map();
  }
  return out;
}

export function createProjectsStore(o: {
  dir: string;
  randomUUID?: () => string;
  isDirectory?: (p: string) => boolean;
}): {
  list(): UiProject[];
  add(absPath: string): Promise<AddProjectResult>;
  remove(id: string): Promise<boolean>;
  pathOf(id: string): string | undefined;
} {
  const isDirectory = o.isDirectory ?? defaultIsDirectory;
  const newId = o.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const projects = load(o.dir);
  let chain: Promise<unknown> = Promise.resolve();

  const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  async function persist(): Promise<void> {
    mkdirSync(o.dir, { recursive: true });
    const body = {
      v: 1,
      projects: [...projects].map(([id, e]) => ({ id, path: e.path, addedAt: e.addedAt })),
    };
    await writeFileAtomically(join(o.dir, GUI_PROJECTS_FILE), JSON.stringify(body));
  }

  return {
    list: () => [...projects].map(([id, e]) => ({ id, name: nameOf(e.path) })),
    pathOf: (id) => (typeof id === 'string' && UUID_RE.test(id) ? projects.get(id)?.path : undefined),
    add: (absPath) =>
      serialise(async (): Promise<AddProjectResult> => {
        if (typeof absPath !== 'string' || !validPath(absPath) || !isDirectory(absPath)) {
          return { ok: false, reason: 'not-a-directory' };
        }
        const path = resolve(absPath);
        const key = dupKey(path);
        for (const e of projects.values()) if (dupKey(resolve(e.path)) === key) return { ok: false, reason: 'duplicate' };
        if (projects.size >= GUI_MAX_PROJECTS) return { ok: false, reason: 'too-many' };
        const id = newId();
        projects.set(id, { path, addedAt: Date.now() });
        try {
          await persist();
        } catch {
          projects.delete(id);
          return { ok: false, reason: 'write-failed' };
        }
        return { ok: true, project: { id, name: nameOf(path) } };
      }),
    remove: (id) =>
      serialise(async () => {
        const prev = typeof id === 'string' && UUID_RE.test(id) ? projects.get(id) : undefined;
        if (!prev) return false;
        projects.delete(id);
        try {
          await persist();
        } catch {
          projects.set(id, prev);
          return false;
        }
        return true;
      }),
  };
}
