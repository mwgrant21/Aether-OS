// The afk CLI verbs (AFK Phase 1, T17). Pure dispatch: the clock, home dir, stdio and TTY facts all arrive in `deps`
// (afk.mjs is the only file that reads them). The four write verbs refuse without a TTY BEFORE they read or create anything.
// Exit codes: 0 ok, 2 usage/unknown verb, 3 TTY required and absent, 4 refused or invalid, 1 unexpected error (a code only, never a message, stack or path).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultTemplatePath, installSkill } from './installSkill.mjs';
import { AMENDABLE_KEYS, termsSha256 } from './terms.mjs';
import { readLiveTerms, writeLiveTerms } from './termsStore.mjs';
import { isNightCurrent } from './nightWindow.mjs';
import { checkFeasibility, realProbes } from './feasibility.mjs';
import { compileNightList } from './compileNightList.mjs';
import { buildDenyRules } from './denyRules.mjs';
import { readApproved } from './approval.mjs';
import { amendDraft, confirmItems, readDraft, replaceDraft } from './draft.mjs';
import { approveNight } from './approveFlow.mjs';
import { resolveNightPlan, unfinishedSelection } from './resolvePlan.mjs';

export const TTY_VERBS = ['terms set', 'amend', 'confirm', 'approve'];
export const VERBS = ['terms show', 'terms set', 'compile', 'feasibility', 'confirm', 'amend', 'approve', 'plan', 'deny-rules', 'install-skill'];

/** The one TTY predicate: both ends must be a terminal. */
export const isInteractive = (stdin, stdout) => Boolean(stdin?.isTTY && stdout?.isTTY);

const NEEDS_TTY = (verb) => `${verb} needs a real terminal: run it in a plain PowerShell window. `
  + 'The terminals inside Aether and the agent tools have no TTY. Nothing was read or written.';
const BARRED_KEYS = ['delete', 'forcePush', 'notifications'];
const BOOL_KEYS = ['push', 'opusEscalation', 'fableElevation'];

// ---- argument helpers -------------------------------------------------------------------------------------------

/** multi flags take every following non-flag token; single flags take one value; bool flags take none. */
function parseFlags(args, { multi = [], single = [], bool = [] }) {
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const name = a.slice(2);
    if (bool.includes(name)) { flags[name] = true; continue; }
    if (single.includes(name)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) return { error: `${a} needs a value` };
      flags[name] = args[++i]; continue;
    }
    if (multi.includes(name)) {
      const vals = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) vals.push(args[++i]);
      if (!vals.length) return { error: `${a} needs a value` };
      flags[name] = [...(flags[name] ?? []), ...vals]; continue;
    }
    return { error: `unknown flag ${a}` };
  }
  return { flags, rest };
}

/** `terms set` and `amend` share these key spellings. Returns {key, value} (key may be 'window' with a part) or {refuse}. */
function parseSetting(key, raw) {
  if (BARRED_KEYS.includes(key)) return { refuse: `${key} cannot be changed: it is barred in the terms` };
  if (key === 'window.start' || key === 'window.end') return { key: 'window', part: key.slice('window.'.length), value: raw };
  if (!AMENDABLE_KEYS.includes(key) || key === 'window') return { refuse: `unknown key: use one of ${[...AMENDABLE_KEYS.filter((k) => k !== 'window'), 'window.start', 'window.end'].join(', ')}` };
  if (BOOL_KEYS.includes(key)) {
    if (raw !== 'true' && raw !== 'false') return { refuse: `${key} must be true or false` };
    return { key, value: raw === 'true' };
  }
  if (key === 'codexReviewsPerPush') {
    if (!/^\d+$/.test(raw)) return { refuse: 'codexReviewsPerPush must be a whole number' };
    return { key, value: Number(raw) };
  }
  return { key, value: raw };
}

const pad = (n) => String(n).padStart(2, '0');
const localTime = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The verified approved record when it is still current, else null. */
function currentApproved(aetherDir, nowMs) {
  const a = readApproved(aetherDir);
  return a.ok && isNightCurrent(nowMs, a.record.targetWindowStartMs) ? a.record : null;
}

function windowFromDraftOrLive(aetherDir, live) {
  return readDraft(aetherDir)?.amendments?.window ?? live.terms.window;
}

// ---- verbs ------------------------------------------------------------------------------------------------------

function termsShow(ctx) {
  const live = readLiveTerms(ctx.aetherDir);
  const lines = [`live terms (${live.source}):`];
  for (const [k, v] of Object.entries(live.terms)) {
    lines.push(k === 'delete' || k === 'forcePush' ? `  ${k}: NOT ALLOWED` : `  ${k}: ${JSON.stringify(v)}`);
  }
  lines.push(`sha256: ${termsSha256(live.terms)}`);
  for (const w of live.warnings) lines.push(`WARNING live terms: ${w}`);
  ctx.print(lines.join('\n'));
  return 0;
}

function termsSet(ctx, args) {
  if (args.length !== 2) { ctx.printErr('usage: terms set <key> <value>'); return 2; }
  const s = parseSetting(args[0], args[1]);
  if (s.refuse) { ctx.printErr(s.refuse); return 4; }
  const live = readLiveTerms(ctx.aetherDir);
  const next = { ...live.terms };
  if (s.key === 'window') next.window = { ...live.terms.window, [s.part]: s.value }; else next[s.key] = s.value;
  let r;
  try {
    r = writeLiveTerms(ctx.aetherDir, next);
  } catch (e) {
    ctx.printErr(`could not write the terms file (${errCode(e)}); nothing was changed`);
    return 1;
  }
  if (!r.ok) { ctx.printErr(`refused: ${r.errors.join('; ')}`); return 4; }
  if (live.warnings.length) {
    for (const w of live.warnings) ctx.print(`WARNING live terms: ${w}`);
    ctx.print('the live terms file was invalid, so it was rewritten from the defaults plus this one change; run terms show and re-set anything else you want');
  }
  ctx.print(`terms updated: ${args[0]} = ${args[1]}`);
  return 0;
}

function compile(ctx, args) {
  const p = parseFlags(args, { multi: ['project', 'plan', 'handoff'], single: ['max-age-days'], bool: ['json'] });
  if (p.error || p.rest.length || !p.flags.project) { ctx.printErr(`usage: compile --project <leaf>... [--plan <path>...] [--handoff <path>...] [--max-age-days N] [--json]${p.error ? ` (${p.error})` : ''}`); return 2; }
  let maxAgeDays;
  if (p.flags['max-age-days'] !== undefined) {
    maxAgeDays = Number(p.flags['max-age-days']);
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) { ctx.printErr('--max-age-days must be a positive number'); return 2; }
  }
  const live = readLiveTerms(ctx.aetherDir);
  const compiled = compileNightList({
    homeDir: ctx.homeDir, projects: p.flags.project, plans: p.flags.plan ?? [], handoffs: p.flags.handoff ?? [],
    nowMs: ctx.nowMs, window: live.terms.window, ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
  });
  const draft = replaceDraft(ctx.aetherDir, compiled, ctx.nowMs);
  const warnings = [...draft.warnings];
  const approved = currentApproved(ctx.aetherDir, ctx.nowMs);
  const standing = approved ? `night ${approved.nightId} is approved and will run; this new draft does not replace it until you approve it` : null;
  if (standing) warnings.push(standing);
  if (p.flags.json) {
    ctx.print(JSON.stringify({
      draftId: draft.draftId, createdAtMs: draft.createdAtMs, targetWindowStartMs: draft.targetWindowStartMs,
      items: draft.items.map((i) => ({ id: i.id, project: i.project, kind: i.kind, artifact: i.artifact, title: i.title, verdict: i.verdict, reasons: i.reasons })),
      warnings,
    }, null, 2));
    return 0;
  }
  const lines = [`draft ${draft.draftId}, targets the window starting ${localTime(draft.targetWindowStartMs)}`];
  for (const v of ['ready', 'question', 'barred']) {
    const group = draft.items.filter((i) => i.verdict === v);
    lines.push('', `${v} (${group.length}):`);
    for (const i of group) lines.push(`  ${i.id}  ${i.title}${i.reasons?.length ? `  [${i.reasons.join(', ')}]` : ''}`);
  }
  for (const w of draft.warnings) lines.push(`warning: ${w}`);
  lines.push('', 'this draft replaces the previous one: every confirmation and amendment starts over.');
  if (standing) lines.push(standing);
  ctx.print(lines.join('\n'));
  return 0;
}

function feasibility(ctx) {
  const draft = readDraft(ctx.aetherDir);
  if (!draft) { ctx.printErr('there is no draft: run compile first'); return 4; }
  const probes = ctx.probes();
  const builds = draft.items.filter((i) => i.kind === 'build');
  if (!builds.length) { ctx.print('no build items in the draft'); return 0; }
  const lines = [];
  for (const i of builds) {
    const r = checkFeasibility(i, probes);
    lines.push(`${i.id}  ${i.title}: ${r.ok ? 'ok' : 'NOT feasible'}`);
    for (const c of r.checks) lines.push(`  ${c.ok ? 'ok     ' : 'MISSING'} ${c.detail}`);
    for (const w of r.warnings) lines.push(`  warning: ${w}`);
  }
  ctx.print(lines.join('\n'));
  return 0;
}

/** Advisory (Open item 9): never changes the exit code. Everything it prints comes from unfinishedSelection. */
function unfinishedPreview(ctx) {
  const draft = readDraft(ctx.aetherDir);
  if (!draft || !draft.items.some((i) => i.confirmed)) return;
  const a = readApproved(ctx.aetherDir);
  if (!a.ok) {
    ctx.print(`no unfinished-night allowlist exists yet: ${a.reason === 'missing'
      ? 'no night has ever been approved, so an unfinished night would run nothing'
      : `the last approval record failed: ${a.reason}`}`);
    return;
  }
  if (draft.createdAtMs <= a.record.approvedAtMs) {
    ctx.print('no unfinished-night allowlist for this draft: the last approval is newer than this draft, so it is not an unfinished night');
    return;
  }
  const s = unfinishedSelection({ draft, record: a.record, ctx: { homeDir: ctx.homeDir, probes: ctx.probes() } });
  ctx.print([
    'if this night ends unfinished (no approve), it would run on the last-approved standing terms with this allowlist:',
    `  terms ${s.termsSha256.slice(0, 8)}`,
    ...s.items.map((i) => `  ${i.id}  ${i.title}`),
    ...s.allowRules.map((r) => `  ${r}`),
    "these are the last-approved terms, not tonight's amendments; approve prints the list for the whole night",
  ].join('\n'));
}

function approvedNote(ctx) {
  const rec = currentApproved(ctx.aetherDir, ctx.nowMs);
  if (rec) ctx.print(`night ${rec.nightId} is approved and will run; this change edits only the draft and does not alter it (only approve does)`);
}

function confirm(ctx, args) {
  const p = parseFlags(args, { bool: ['all-ready'] });
  if (p.error || (!p.flags['all-ready'] && !p.rest.length) || (p.flags['all-ready'] && p.rest.length)) {
    ctx.printErr('usage: confirm <id>... | --all-ready'); return 2;
  }
  const before = readDraft(ctx.aetherDir);
  if (!before) { ctx.printErr('there is no draft: run compile first'); return 4; }
  const ids = p.flags['all-ready'] ? before.items.filter((i) => i.verdict === 'ready').map((i) => i.id) : p.rest;
  const r = confirmItems(ctx.aetherDir, ids, { homeDir: ctx.homeDir, probes: ctx.probes() }, ctx.nowMs);
  const lines = [];
  for (const id of r.confirmed) lines.push(`confirmed ${id}  ${before.items.find((i) => i.id === id)?.title ?? ''}`);
  for (const f of r.refused) lines.push(`refused ${f.id}: ${f.reason}${f.reason === 'stale-draft' ? ' (the draft window is over: run compile again)' : ''}`);
  if (!ids.length) lines.push('nothing is ready to confirm');
  ctx.print(lines.join('\n'));
  approvedNote(ctx);
  try { unfinishedPreview(ctx); } catch { ctx.print('could not compute the unfinished-night allowlist'); }
  return r.refused.length ? 4 : 0;
}

function amend(ctx, args) {
  if (args.length !== 2) { ctx.printErr('usage: amend <key> <value>'); return 2; }
  const s = parseSetting(args[0], args[1]);
  if (s.refuse) { ctx.printErr(s.refuse); return 4; }
  const patch = {};
  if (s.key === 'window') patch.window = { ...windowFromDraftOrLive(ctx.aetherDir, readLiveTerms(ctx.aetherDir)), [s.part]: s.value }; else patch[s.key] = s.value;
  const r = amendDraft(ctx.aetherDir, patch, ctx.nowMs);
  if (!r.ok) { ctx.printErr(`refused: ${r.errors.join('; ')}${r.errors.includes('stale-draft') ? ' (the draft window is over: run compile again)' : ''}`); return 4; }
  ctx.print(`draft amended: ${args[0]} = ${args[1]} (this night only)`);
  approvedNote(ctx);
  return 0;
}

async function approve(ctx, deps) {
  const r = await approveNight({
    aetherDir: ctx.aetherDir, homeDir: ctx.homeDir, probes: ctx.probes(), nowMs: ctx.nowMs,
    isTty: deps.isTty, readLine: deps.readLine, print: ctx.print,
  });
  if (!r.ok) { ctx.printErr(r.message || 'approve was refused'); return 4; }
  ctx.print(`night ${r.record.nightId} approved: ${r.record.items.length} item(s) will run in the window starting ${localTime(r.record.targetWindowStartMs)}`);
  return 0;
}

function plan(ctx, args) {
  const p = parseFlags(args, { bool: ['json'] });
  if (p.error || p.rest.length) { ctx.printErr('usage: plan [--json]'); return 2; }
  const r = resolveNightPlan({ aetherDir: ctx.aetherDir, homeDir: ctx.homeDir, probes: ctx.deps.probes, nowMs: ctx.nowMs });
  if (p.flags.json) { ctx.print(JSON.stringify(r, null, 2)); return 0; }
  const lines = [`kind: ${r.kind}`, `reason: ${r.reason}`];
  if (r.kind !== 'none') {
    lines.push(`night: ${r.nightId}`, `window start: ${localTime(r.targetWindowStartMs)}`, 'items:');
    for (const i of r.items) lines.push(`  ${i.id}  ${i.title}`);
    if (r.held.length) { lines.push('held:'); for (const h of r.held) lines.push(`  ${h.id}  ${h.title}  (${h.reason})`); }
    lines.push('allowlist:', ...r.allowRules.map((x) => `  ${x}`));
  }
  ctx.print(lines.join('\n'));
  return 0;
}

function denyRules(ctx) {
  const live = readLiveTerms(ctx.aetherDir);
  for (const w of live.warnings) ctx.printErr(`WARNING live terms: ${w}`);   // stderr, so stdout stays parseable JSON
  const d = buildDenyRules(live.terms);
  ctx.print(JSON.stringify({ protect: d.protect, run: d.run }, null, 2));
  return 0;
}

function installSkillVerb(ctx) {
  const templatePath = defaultTemplatePath();
  if (!existsSync(templatePath)) { ctx.printErr(`install-skill: template not found at ${templatePath}. Nothing was written.`); return 4; }
  const cliPath = fileURLToPath(new URL('./afk.mjs', import.meta.url)).replace(/\\/g, '/');
  ctx.print(`installed ${installSkill({ homeDir: ctx.homeDir, templatePath, cliPath })}`);
  return 0;
}

const errCode =(e) => (e && typeof e.code === 'string' ? e.code : 'internal error');

function verbOf(argv) {
  if (argv[0] === 'terms') return { verb: `terms ${argv[1] ?? ''}`.trim(), args: argv.slice(2) };
  return { verb: argv[0], args: argv.slice(1) };
}

/** @returns {Promise<number>} */
export async function main(argv, deps) {
  const printErr = deps.printErr ?? ((s) => process.stderr.write(`${s}\n`));
  const { verb, args } = verbOf(argv);
  if (!VERBS.includes(verb)) { printErr(`unknown verb. verbs: ${VERBS.join(', ')}`); return 2; }
  // The TTY check is the first thing a write verb does: no read, no mkdir, no prompt before it.
  if (TTY_VERBS.includes(verb) && !deps.isTty) { printErr(NEEDS_TTY(verb)); return 3; }
  const ctx = {
    deps, homeDir: deps.homeDir, nowMs: deps.nowMs, aetherDir: join(deps.homeDir, '.aether-os'),
    print: deps.print, printErr,
    probes: () => deps.probes ?? realProbes({ homeDir: deps.homeDir, env: deps.env }),
  };
  try {
    switch (verb) {
      case 'terms show': return termsShow(ctx);
      case 'terms set': return termsSet(ctx, args);
      case 'compile': return compile(ctx, args);
      case 'feasibility': return feasibility(ctx);
      case 'confirm': return confirm(ctx, args);
      case 'amend': return amend(ctx, args);
      case 'approve': return await approve(ctx, deps);
      case 'plan': return plan(ctx, args);
      case 'deny-rules': return denyRules(ctx);
      default: return installSkillVerb(ctx);
    }
  } catch (e) {
    try { printErr(`unexpected error (${errCode(e)})`); } catch { /* stderr gone */ }
    return 1;
  }
}
