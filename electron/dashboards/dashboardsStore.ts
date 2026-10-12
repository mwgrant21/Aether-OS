import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBoardId, validateSpec, type DashboardSpec, type Range } from '../../src/shared/dashboards/spec';
import { RENDER_ROW_CAP } from '../../src/shared/dashboards/queryGuard';
import type { BoardSummary, BoardsListing, RefreshResponse } from '../../src/shared/dashboards/types';
import { evaluatePanel } from './evaluatePanel';

export interface DashboardsStoreOptions { dir: string; dbPath: string; starters?: DashboardSpec[]; now?: () => number; debounceMs?: number }
export interface DashboardsStore {
  list(): BoardsListing;
  refresh(id: string, rangeOverride?: Range): Promise<RefreshResponse>;
  remove(id: string): { ok: boolean; error?: string };
  seedStarters(): void;
  startWatching(onChange: (ids: string[]) => void): () => void;
}

const SEEDED_MARKER = '.seeded';

// fs error messages embed the absolute path, and JSON.parse messages can echo file content.
// Only the errno code is safe to send to the renderer.
function errCode(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function createDashboardsStore(opts: DashboardsStoreOptions): DashboardsStore {
  const now = opts.now ?? Date.now;
  const ensureDir = () => mkdirSync(opts.dir, { recursive: true });
  const fileFor = (id: string) => join(opts.dir, `${id}.json`);

  function readBoard(id: string): { spec: DashboardSpec } | { error: string } {
    let text: string;
    try { text = readFileSync(fileFor(id), 'utf8'); } catch (e) { return { error: `could not read (${errCode(e)})` }; }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { error: 'invalid JSON' }; }
    const v = validateSpec(raw);
    if (!v.ok) return { error: v.errors[0] };
    if (v.spec.id !== id) return { error: `id "${v.spec.id}" does not match its file name "${id}.json"` };
    return { spec: v.spec };
  }

  function summarize(id: string): BoardSummary {
    const r = readBoard(id);
    if ('error' in r) return { id, title: id, error: r.error, panels: [] };
    return {
      id, title: r.spec.title, error: null,
      panels: r.spec.panels.map((p) => ({ id: p.id, title: p.title, type: p.type, range: p.range, sql: p.sql,
        costBasis: p.cost?.basis ?? null, x: p.x ?? null, y: p.y ?? [] })),
    };
  }

  return {
    list() {
      ensureDir();
      const ids = readdirSync(opts.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => isBoardId(id)).sort();
      return { collectorAvailable: existsSync(opts.dbPath), boards: ids.map(summarize) };
    },

    async refresh(id, rangeOverride) {
      if (!isBoardId(id)) return { ok: false, error: 'Unknown board.' };
      const r = readBoard(id);
      if ('error' in r) return { ok: false, error: r.error };
      const nowMs = now();
      const panels = await Promise.all(r.spec.panels.map((p) => evaluatePanel(p, { dbPath: opts.dbPath, nowMs, rowCap: RENDER_ROW_CAP, rangeOverride })));
      return { ok: true, panels };
    },

    remove(id) {
      if (!isBoardId(id)) return { ok: false, error: 'Unknown board.' };
      try { unlinkSync(fileFor(id)); return { ok: true }; } catch (e) { return { ok: false, error: `could not delete (${errCode(e)})` }; }
    },

    seedStarters() {
      ensureDir();
      const markerPath = join(opts.dir, SEEDED_MARKER);
      let seeded: string[] = [];
      try {
        const v: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (Array.isArray(v)) seeded = v.filter((s): s is string => typeof s === 'string');
      } catch { /* first run */ }
      let changed = false;
      for (const s of opts.starters ?? []) {
        if (seeded.includes(s.id)) continue;
        // Seeded once: an edited starter is never overwritten and a deleted one never returns.
        try { if (!existsSync(fileFor(s.id))) writeFileSync(fileFor(s.id), `${JSON.stringify(s, null, 2)}\n`, { flag: 'wx' }); } catch { /* raced a writer; keep theirs */ }
        seeded.push(s.id);
        changed = true;
      }
      if (changed) writeFileSync(markerPath, JSON.stringify(seeded));
    },

    startWatching(onChange) {
      ensureDir();
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(opts.dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.endsWith('.json')) return;
        const id = name.slice(0, -5);
        if (!isBoardId(id)) return;
        pending.add(id);
        clearTimeout(timer);
        timer = setTimeout(() => { const ids = [...pending]; pending.clear(); onChange(ids); }, opts.debounceMs ?? 250);
      });
      return () => { clearTimeout(timer); watcher.close(); };
    },
  };
}
