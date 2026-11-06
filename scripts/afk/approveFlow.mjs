// The approval flow (AFK Phase 1, T15): only a person at a TTY who types the exact phrase writes the approved record.
// Every early return writes nothing; `not-tty` and `terms-invalid` also print and ask nothing.
// No clock reads: everything takes nowMs. isTty, readLine and print are injected.
// All file access goes through fsJson via approval.mjs, termsStore.mjs and draft.mjs.
import { applyAmendments, DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { readLiveTerms } from './termsStore.mjs';
import { isNightCurrent } from './nightWindow.mjs';
import { buildAllowRules, buildDenyRules } from './denyRules.mjs';
import { buildRecord, readApproved, writeApproved } from './approval.mjs';
import { readDraft, recheckItem } from './draft.mjs';

/** `APPROVE ` + the first 8 hex of the EFFECTIVE terms' hash, so approving a stale summary after the terms changed fails. */
export const expectedPhrase = (hash) => `APPROVE ${hash.slice(0, 8)}`;

const pad = (n) => String(n).padStart(2, '0');
const localTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fail = (code, message) => ({ ok: false, code, message });

const NOT_TTY = 'approve needs a real terminal. Open a plain PowerShell window and run the approve verb there; '
  + 'the terminals inside Aether and the agent tools have no TTY, so it will refuse again anywhere else.';

const LIMIT_PUSH = 'Limit 1: Bash(git push:*) is a prefix rule, so it also permits +refspec, :branch, origin main --force and '
  + 'origin HEAD:master pushes (the last is a push straight to master that skips merge-gate; the deny list stops only the exact forms '
  + '`git push origin HEAD:master` and `HEAD:main`, not other spellings). Only the deny list\'s --force/-f prefixes and exact-form rules '
  + '(for the forms they match) and the Safety Net hook may stop those; force-push is barred by the terms, not by this list.';
const LIMIT_EDIT = 'Limit 2: there are no Edit/Write/test rules in this list, so work and plan items cannot edit files unattended '
  + 'unless Phase 2 adds them, and will go yellow.';

function termLines(terms) {
  const lines = [];
  for (const k of Object.keys(terms)) {
    const differs = JSON.stringify(terms[k]) !== JSON.stringify(DEFAULT_TERMS[k]);
    lines.push(`  ${k}: ${JSON.stringify(terms[k])}${differs ? '   (differs from default)' : ''}`);
  }
  return lines;
}

function summary({ draft, effective, confirmed, held, allowRules, prior }) {
  const out = [];
  out.push(`runs in the window starting ${localTime(draft.targetWindowStartMs)}`);
  out.push('', 'terms in effect:', ...termLines(effective));
  const amended = Object.keys(draft.amendments ?? {});
  if (amended.length) {
    out.push('', 'one-night amendments:', ...amended.map((k) => `  ${k}: ${JSON.stringify(draft.amendments[k])}`));
    out.push('amendments apply to tonight only; an unfinished night falls back to the standing terms');
  }
  out.push('', 'delete: NOT ALLOWED');
  out.push('', 'confirmed items:', ...confirmed.map((i) => `  ${i.id}  ${i.title}`));
  out.push('', 'held items:', ...(held.length ? held.map((h) => `  ${h.id}  ${h.title}  (${h.reason})`) : ['  none']));
  out.push('', 'allowlist (Phase 2 will pass exactly these):', ...allowRules.map((r) => `  ${r}`));
  out.push('', LIMIT_PUSH, LIMIT_EDIT);
  const deny = buildDenyRules(effective);
  out.push('', 'deny list, protect:', ...deny.protect.map((r) => `  ${r}`), 'deny list, run:', ...deny.run.map((r) => `  ${r}`));
  if (prior.ok) out.push('', `replaces approval ${prior.record.nightId} (window start ${localTime(prior.record.targetWindowStartMs)})`);
  return out.join('\n');
}

/** @returns {Promise<{ok:true, record:object} | {ok:false, code:string, message:string}>} */
export async function approveNight({ aetherDir, homeDir, repoRoots, probes, nowMs, isTty, readLine, print }) {
  if (!isTty) return fail('not-tty', NOT_TTY);
  const draft = readDraft(aetherDir);
  if (!draft) return fail('no-draft', 'there is no draft: run compile, then confirm, then approve');

  const live = readLiveTerms(aetherDir);
  if (live.warnings.length) {
    return fail('terms-invalid', `${live.warnings.join('; ')}. The live terms are not something to approve: terms set rewrites a valid file.`);
  }
  const eff = applyAmendments(live.terms, draft.amendments ?? {});
  if (!eff.ok) return fail('terms-invalid', `the draft's amendments are invalid: ${eff.errors.join('; ')}`);
  const effective = eff.terms;

  const confirmed = draft.items.filter((i) => i.confirmed === true);
  if (confirmed.length === 0) return fail('no-confirmed-items', 'nothing is confirmed: run confirm for the items to approve');
  if (!isNightCurrent(nowMs, draft.targetWindowStartMs)) {
    return fail('stale-draft', `the draft targets the window starting ${localTime(draft.targetWindowStartMs)}, which is over: re-run compile, then confirm`);
  }

  const failures = [];
  for (const item of confirmed) {
    const r = recheckItem(item, { homeDir, repoRoots, probes });
    if (!r.ok) failures.push(`${item.id}  ${item.title}: ${r.reason}`);
  }
  if (failures.length) return fail('recheck-failed', `confirmed items no longer hold:\n${failures.join('\n')}\nre-run compile, then confirm`);

  const recItems = confirmed.map((i) => ({ id: i.id, project: i.project, kind: i.kind, artifact: i.artifact, title: i.title, source: i.source }));
  const held = draft.items.filter((i) => i.confirmed !== true)
    .map((i) => ({ id: i.id, title: i.title, verdict: i.verdict, reason: (i.reasons && i.reasons[0]) || 'not-confirmed' }));
  const allowRules = buildAllowRules(effective, recItems);

  print(summary({ draft, effective, confirmed: recItems, held, allowRules, prior: readApproved(aetherDir) }));
  const phrase = expectedPhrase(termsSha256(effective));
  const typed = await readLine(`Type exactly: ${phrase}`);
  if (typeof typed !== 'string' || typed.trim() !== phrase) return fail('phrase-mismatch', 'the phrase did not match; nothing was written');

  const record = buildRecord({
    nightId: draft.draftId, approvedAtMs: nowMs, targetWindowStartMs: draft.targetWindowStartMs,
    standingTerms: live.terms, amendments: draft.amendments ?? {}, terms: effective, items: recItems, held, allowRules,
  });
  writeApproved(aetherDir, record);
  const back = readApproved(aetherDir);
  if (!back.ok || back.record.recordSha256 !== record.recordSha256) {
    return fail('verify-failed', `the record written did not verify (${back.ok ? 'hash differs' : back.reason}); run approve again`);
  }
  return { ok: true, record };
}
