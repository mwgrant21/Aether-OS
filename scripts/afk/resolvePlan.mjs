// What runs tonight (AFK Phase 1, T16): exactly one of approved | unfinished | none.
// An approved night comes from the verified approved.json alone; draft.json and the live terms file are never consulted for it.
// An unfinished night runs the draft's confirmed items on the last approval's STANDING terms; the live terms file is never read.
// No clock reads and no state between calls: everything takes nowMs, and the caller owns run-once keyed on targetWindowStartMs.
import { buildAllowRules } from './denyRules.mjs';
import { readApproved } from './approval.mjs';
import { readDraft, recheckItem } from './draft.mjs';
import { realProbes } from './feasibility.mjs';
import { isNightCurrent, windowFor } from './nightWindow.mjs';
import { termsSha256 } from './terms.mjs';

const none = (reason) => ({
  kind: 'none', nightId: null, targetWindowStartMs: null, terms: null, termsSha256: null,
  items: [], held: [], allowRules: [], reason,
});

const project = (i) => ({ id: i.id, project: i.project, kind: i.kind, artifact: i.artifact, title: i.title, source: i.source });

/** THE one computation of what an unfinished night runs. No window gate, no `none` case. ctx = {homeDir, repoRoots?, probes}. */
export function unfinishedSelection({ draft, record, ctx }) {
  const terms = record.standingTerms;
  const items = [];
  const held = [];
  for (const i of draft.items) {
    if (i.confirmed) {
      const r = recheckItem(i, ctx);
      if (r.ok) { items.push(project(i)); continue; }
      held.push({ id: i.id, title: i.title, verdict: i.verdict, reason: `recheck:${r.reason}` });
    } else {
      held.push({ id: i.id, title: i.title, verdict: i.verdict, reason: (Array.isArray(i.reasons) && i.reasons[0]) || 'not-confirmed' });
    }
  }
  return { terms, termsSha256: termsSha256(terms), items, held, allowRules: buildAllowRules(terms, items) };
}

export function resolveNightPlan({ aetherDir, homeDir, repoRoots, probes, nowMs }) {
  try {
    const a = readApproved(aetherDir);
    if (!a.ok && a.reason !== 'missing') return none(`approval record failed: ${a.reason}`);
    if (a.ok && isNightCurrent(nowMs, a.record.targetWindowStartMs)) {
      const r = a.record;
      return {
        kind: 'approved', nightId: r.nightId, targetWindowStartMs: r.targetWindowStartMs, terms: r.terms,
        termsSha256: r.termsSha256, items: r.items, held: r.held, allowRules: r.allowRules, reason: 'approved night',
      };
    }
    const draft = readDraft(aetherDir);
    if (draft && draft.items.some((i) => i.confirmed)) {
      if (!a.ok) return none('no last-approved terms');
      if (draft.createdAtMs > a.record.approvedAtMs) {
        const target = windowFor(draft.targetWindowStartMs, a.record.standingTerms.window).startMs;
        if (isNightCurrent(nowMs, target)) {
          const ctx = { homeDir, repoRoots, probes: probes ?? realProbes({ homeDir, repoRoots, env: process.env }) };
          const s = unfinishedSelection({ draft, record: a.record, ctx });
          return { kind: 'unfinished', nightId: draft.draftId, targetWindowStartMs: target, ...s, reason: 'unfinished night on the last-approved terms' };
        }
      }
    }
    return none('no current approved night and nothing confirmed');
  } catch (e) {
    return none(`resolve failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
