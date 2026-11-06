// The one draft (AFK Phase 1, T14): <afk>/draft.json is the only draft there is.
// replaceDraft overwrites it wholesale, so a confirmation or amendment can never outlive the verdict it was made against.
// CARRY: replaceDraft takes `createdAtMs` from `compiled.createdAtMs` (the compile's own clock), NOT from its `nowMs`
// argument; `nowMs` only labels the draft (`draftId`). Do not confuse the two.
// Logic only: every function takes nowMs, nothing here reads the clock. All file access goes through fsJson.
import { join } from 'node:path';
import { applyAmendments } from './terms.mjs';
import { afkDir, readLiveTerms } from './termsStore.mjs';
import { isNightCurrent, newNightId, windowFor } from './nightWindow.mjs';
import { checkFeasibility } from './feasibility.mjs';
import { checkPlan } from './compileNightList.mjs';
import { readJsonSafe, writeJsonAtomic } from './fsJson.mjs';

export const draftPath = (aetherDir) => join(afkDir(aetherDir), 'draft.json');

/** Null for a missing file, unparseable JSON, or a file with no `items` array (a torn write reads as no draft). */
export function readDraft(aetherDir) {
  const r = readJsonSafe(draftPath(aetherDir));
  if (!r.ok || !r.value || typeof r.value !== 'object' || !Array.isArray(r.value.items)) return null;
  return r.value;
}

/** Replaces whatever draft exists; every item is written unconfirmed and amendments start empty. */
export function replaceDraft(aetherDir, compiled, nowMs) {
  const draft = {
    v: 1,
    draftId: newNightId(nowMs),
    createdAtMs: compiled.createdAtMs,
    targetWindowStartMs: compiled.targetWindowStartMs,
    projects: compiled.projects,
    warnings: compiled.warnings,
    items: compiled.items.map((i) => ({ ...i, confirmed: false })),
    amendments: {},
  };
  writeJsonAtomic(draftPath(aetherDir), draft);
  return draft;
}

/** Reads the world as it is now (plan, spec, feasibility); does not re-read handoffs. ctx = {homeDir, repoRoots?, probes}. */
export function recheckItem(item, ctx) {
  if (item.verdict !== 'ready') return { ok: false, reason: `not-ready:${item.verdict}` };
  if (item.planRef) {
    const p = checkPlan({ homeDir: ctx.homeDir, repoRoots: ctx.repoRoots, project: item.project, file: item.planRef.file });
    if (!p.found) return { ok: false, reason: 'plan-not-found' };
    if (!p.specApproved) return { ok: false, reason: 'spec-not-approved' };
  }
  if (item.kind === 'build' && !checkFeasibility(item, ctx.probes).ok) return { ok: false, reason: 'feasibility' };
  return { ok: true, reason: null };
}

export function confirmItems(aetherDir, ids, ctx, nowMs) {
  const draft = readDraft(aetherDir);
  if (!draft) return { confirmed: [], refused: ids.map((id) => ({ id, reason: 'no-draft' })) };
  if (!isNightCurrent(nowMs, draft.targetWindowStartMs)) {
    return { confirmed: [], refused: ids.map((id) => ({ id, reason: 'stale-draft' })) };
  }
  const confirmed = [];
  const refused = [];
  for (const id of ids) {
    const item = draft.items.find((i) => i.id === id);
    if (!item) { refused.push({ id, reason: 'unknown' }); continue; }
    const r = recheckItem(item, ctx);
    if (!r.ok) { refused.push({ id, reason: r.reason }); continue; }
    item.confirmed = true;
    confirmed.push(id);
  }
  if (confirmed.length) writeJsonAtomic(draftPath(aetherDir), draft);
  return { confirmed, refused };
}

/** The stale check runs before the patch is applied, so a `window` patch cannot revive a stale draft. */
export function amendDraft(aetherDir, patch, nowMs) {
  const draft = readDraft(aetherDir);
  if (!draft) return { ok: false, errors: ['no draft'] };
  if (!isNightCurrent(nowMs, draft.targetWindowStartMs)) return { ok: false, errors: ['stale-draft'] };
  const merged = { ...(draft.amendments ?? {}), ...patch };
  const r = applyAmendments(readLiveTerms(aetherDir).terms, merged);
  if (!r.ok) return { ok: false, errors: r.errors };
  draft.amendments = merged;
  if (Object.hasOwn(merged, 'window')) draft.targetWindowStartMs = windowFor(nowMs, r.terms.window).startMs;
  writeJsonAtomic(draftPath(aetherDir), draft);
  return { ok: true, errors: [] };
}
