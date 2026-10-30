// electron/control/viewWire.ts
//
// Fail-closed payload encoders for the generic view channel (view.snap `d`). Each encoder rebuilds its payload field by
// field in the golden's key order (no pass-through of the input), masks free text with maskSecrets BEFORE capping it,
// and returns null if any number or shape fails validation: the frame then carries d:null, never a partial payload.
// The phone reads the goldens in protocol/mobile-protocol.json.
import { maskSecrets } from '../../src/shared/board/text';
import type { ProjectsWire } from '../../src/shared/remote/types';
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
