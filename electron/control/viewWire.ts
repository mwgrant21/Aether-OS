// electron/control/viewWire.ts
//
// Fail-closed payload encoders for the generic view channel (view.snap `d`). Each encoder rebuilds its payload field by
// field in the golden's key order (no pass-through of the input), masks free text with maskSecrets BEFORE capping it,
// and returns null if any number or shape fails validation: the frame then carries d:null, never a partial payload.
// The phone reads the goldens in protocol/mobile-protocol.json.
import { maskSecrets } from '../../src/shared/board/text';
import type { MemoryWire, ProjectsWire } from '../../src/shared/remote/types';
import { shapeLedgerFields } from './protocol';

export const PROJECTS_MAX_ROOTS = 50;
export const PROJECTS_MAX_CHILDREN = 20;
export const PROJECTS_TEXT_CAP = 60;
const KEY_MAX = 64;

const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** Mask, then cap at n UTF-16 units without leaving half a surrogate pair. */
function text(x: unknown, n: number): string | null {
  if (typeof x !== 'string') return null;
  let t = maskSecrets(x);
  if (t.length > n) {
    t = t.slice(0, n);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  }
  return t;
}

const keyOf = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 && x.length <= KEY_MAX ? x : null);

/**
 * `projects`: {computedAtMs, all, unscoped, roots:[{key,name,total,tiers,rollups,cache,children:[{key,worktree,...}]}]}.
 * children is [] for a root with a single checkout. Roots keep the order received (main sorts by cost), capped at 50
 * roots and 20 children each. No paths, no optimize findings, no transcript titles.
 */
export function encodeProjectsView(w: ProjectsWire | null): Record<string, unknown> | null {
  if (w === null || typeof w !== 'object' || !count(w.computedAtMs) || !Array.isArray(w.roots)) return null;
  const all = shapeLedgerFields(w.all);
  if (all === null) return null;
  let unscoped: ReturnType<typeof shapeLedgerFields> = null;
  if (w.unscoped !== null) {
    unscoped = shapeLedgerFields(w.unscoped);
    if (unscoped === null) return null;
  }
  const roots: Record<string, unknown>[] = [];
  for (const r of w.roots.slice(0, PROJECTS_MAX_ROOTS)) {
    if (typeof r !== 'object' || r === null || !Array.isArray(r.children)) return null;
    const key = keyOf(r.key);
    const name = text(r.name, PROJECTS_TEXT_CAP);
    const f = shapeLedgerFields(r.ledger);
    if (key === null || name === null || f === null) return null;
    const children: Record<string, unknown>[] = [];
    if (r.children.length > 1) {
      for (const c of r.children.slice(0, PROJECTS_MAX_CHILDREN)) {
        if (typeof c !== 'object' || c === null) return null;
        const ck = keyOf(c.key);
        const worktree = c.worktree === null ? null : text(c.worktree, PROJECTS_TEXT_CAP);
        const cf = shapeLedgerFields(c.ledger);
        if (ck === null || (c.worktree !== null && worktree === null) || cf === null) return null;
        children.push({ key: ck, worktree, ...cf });
      }
    }
    roots.push({ key, name, ...f, children });
  }
  return { computedAtMs: w.computedAtMs, all, unscoped, roots };
}

export const MEMORY_MAX_LIVE = 150;
export const MEMORY_MAX_TOMBSTONES = 60;
export const MEMORY_CONTENT_CAP = 600;
export const MEMORY_SUBJECT_CAP = 80;
export const MEMORY_OWNER_CAP = 60;
const MEMORY_KINDS = ['decision', 'preference', 'overrule', 'habit', 'revision'];
const MEMORY_STATUSES = ['open', 'moving', 'settled'];
const MEMORY_SCOPES = ['shared', 'private'];
const MEMORY_CAUSES = ['superseded', 'operator', 'invalidated'];

const oneOf = (list: readonly string[], x: unknown): x is string => typeof x === 'string' && list.includes(x);
const nullableText = (x: unknown, n: number): string | null | undefined => (x === null ? null : (text(x, n) ?? undefined));

/**
 * `memory`: {computedAtMs, counts:{live,tombstones}, live:[...], tombstones:[...], extraction:null}. counts are the totals
 * before capping. Live rows: highest salience first, then most recently updated, capped at 150; tombstones newest first,
 * capped at 60. content and subject are masked (maskSecrets is a floor, not a guarantee) then capped. Reference counts
 * and extraction cost are never sent; `extraction` is reserved and always null. Free text is the owner's own memory.
 */
export function encodeMemoryView(w: MemoryWire | null): Record<string, unknown> | null {
  if (w === null || typeof w !== 'object' || !count(w.computedAtMs) || !Array.isArray(w.live) || !Array.isArray(w.tombstones)) return null;
  for (const r of w.live) {
    if (typeof r !== 'object' || r === null || !count(r.id) || !oneOf(MEMORY_SCOPES, r.scope) || !oneOf(MEMORY_KINDS, r.kind)) return null;
    if (!(r.status === null || oneOf(MEMORY_STATUSES, r.status))) return null;
    if (typeof r.salience !== 'number' || !Number.isFinite(r.salience) || r.salience < 0) return null;
    if (!count(r.createdAtMs) || !count(r.updatedAtMs)) return null;
  }
  for (const t of w.tombstones) {
    if (typeof t !== 'object' || t === null || !count(t.id) || !oneOf(MEMORY_SCOPES, t.scope) || !oneOf(MEMORY_CAUSES, t.cause)) return null;
    if (!count(t.deletedAtMs) || !(t.supersededBy === null || count(t.supersededBy))) return null;
  }
  const liveTop = [...w.live].sort((a, b) => b.salience - a.salience || b.updatedAtMs - a.updatedAtMs || b.id - a.id).slice(0, MEMORY_MAX_LIVE);
  const tombTop = [...w.tombstones].sort((a, b) => b.deletedAtMs - a.deletedAtMs || b.id - a.id).slice(0, MEMORY_MAX_TOMBSTONES);
  const live: Record<string, unknown>[] = [];
  for (const r of liveTop) {
    const owner = nullableText(r.ownerAgent, MEMORY_OWNER_CAP);
    const subject = nullableText(r.subject, MEMORY_SUBJECT_CAP);
    const content = text(r.content, MEMORY_CONTENT_CAP);
    if (owner === undefined || subject === undefined || content === null) return null;
    live.push({ id: r.id, scope: r.scope, owner, kind: r.kind, status: r.status, salience: Math.round(r.salience * 10000) / 10000, subject, content, createdAtMs: r.createdAtMs, updatedAtMs: r.updatedAtMs });
  }
  const tombstones: Record<string, unknown>[] = [];
  for (const t of tombTop) {
    const owner = nullableText(t.ownerAgent, MEMORY_OWNER_CAP);
    const content = text(t.content, MEMORY_CONTENT_CAP);
    if (owner === undefined || content === null) return null;
    tombstones.push({ id: t.id, scope: t.scope, owner, content, deletedAtMs: t.deletedAtMs, cause: t.cause, supersededBy: t.supersededBy });
  }
  return { computedAtMs: w.computedAtMs, counts: { live: w.live.length, tombstones: w.tombstones.length }, live, tombstones, extraction: null };
}
