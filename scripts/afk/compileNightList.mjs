// Night-list compiler. Reads handoffs, ledgers and named plans under a home dir, classifies each
// item and returns plain data. Never throws on missing inputs; warnings carry project names and
// basenames only, never absolute paths. Plan checkboxes are never read.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { windowFor } from './nightWindow.mjs';
import { parseLedgerTodos, parseNextSteps } from './parseSources.mjs';
import { planRefsIn, specIsApproved, specPathOfPlan } from './planRefs.mjs';
import { classifyItem } from './classify.mjs';
import { detectArtifact } from './recipes.mjs';

const DAY_MS = 864e5;
const TITLE_MAX = 140;
const SKIP_PREFIX = /^(ledger|verdict|scratch|debug)-/i;
const DEFAULT_WINDOW = { start: '01:00', end: '07:00' };

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function readText(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function repoRootOf(homeDir, repoRoots, project) {
  return (own(repoRoots, project) && repoRoots[project]) || join(homeDir, 'projects', project);
}

function inside(root, p) {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

// Plan file under the repo root, then the spec named on its **Spec:** line (relative to the same root).
export function checkPlan({ homeDir, repoRoots, project, file }) {
  const root = repoRootOf(homeDir, repoRoots, project);
  const planPath = join(root, 'docs', 'superpowers', 'plans', basename(String(file)));
  const text = existsSync(planPath) ? readText(planPath) : null;
  if (text === null) return { found: false, specApproved: false };
  const spec = specPathOfPlan(text);
  if (!spec) return { found: true, specApproved: false };
  const specPath = resolve(root, spec);
  if (!inside(root, specPath)) return { found: true, specApproved: false };
  const specText = readText(specPath);
  return { found: true, specApproved: specText !== null && specIsApproved(specText) };
}

function listMd(dir, nowMs, maxAgeMs, warnings, project) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const out = [];
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    let st;
    try { st = statSync(join(dir, name)); } catch { warnings.push(`${project}: could not stat ${name}`); continue; }
    if (!st.isFile() || nowMs - st.mtimeMs > maxAgeMs) continue;
    out.push({ name, path: join(dir, name), mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  return out;
}

// Configured repo roots decide ownership first; path-component matching is the fallback.
function projectOfPath(p, projects, repoRoots) {
  for (const proj of projects) {
    if (!own(repoRoots, proj) || !repoRoots[proj]) continue;
    const root = resolve(repoRoots[proj]);
    if (resolve(p) === root || inside(root, p)) return proj;
  }
  const parts = resolve(p).split(/[\\/]/);
  for (const proj of projects) if (parts.includes(proj)) return proj;
  return projects[0];
}

function makeItem(project, text, source, extraReasons) {
  const norm = squash(text);
  const artifact = detectArtifact(norm);
  const c = classifyItem(norm);
  let verdict = c.verdict;
  const reasons = [...c.reasons];
  const add = (code) => {
    if (verdict === 'barred') return;   // barred beats question
    verdict = 'question';
    if (!reasons.includes(code)) reasons.push(code);
  };
  for (const code of extraReasons) add(code);
  if (artifact === 'both') add('question:two-artifacts');
  const id = createHash('sha256').update(`${project}|${norm.toLowerCase()}`).digest('hex').slice(0, 12);
  return {
    id,
    project,
    kind: artifact === 'apk' || artifact === 'installer' ? 'build' : 'work',
    artifact: artifact === 'both' ? null : artifact,
    title: norm.slice(0, TITLE_MAX),
    source,
    verdict,
    reasons,
    confirmed: false,
  };
}

export function compileNightList({
  homeDir, projects, plans = [], handoffs = [], repoRoots, nowMs, maxAgeDays = 3, window = DEFAULT_WINDOW,
}) {
  const warnings = [];
  const items = [];
  const seen = new Map();
  const maxAgeMs = maxAgeDays * DAY_MS;
  // Duplicate ids merge conservatively in either encounter order: the most restrictive verdict wins
  // (barred > question > ready) and reasons are kept, except that a barred item carries no question: reasons.
  const RANK = { ready: 0, question: 1, barred: 2 };
  const push = (it) => {
    const prev = seen.get(it.id);
    if (!prev) { seen.set(it.id, it); items.push(it); return; }
    if (RANK[it.verdict] > RANK[prev.verdict]) prev.verdict = it.verdict;
    for (const r of it.reasons) if (!prev.reasons.includes(r)) prev.reasons.push(r);
    if (prev.verdict === 'barred') prev.reasons = prev.reasons.filter((r) => !r.startsWith('question:'));
  };

  const applyPlans = (it, text) => {
    for (const file of planRefsIn(text)) {
      const r = checkPlan({ homeDir, repoRoots, project: it.project, file });
      if (!r.found) {
        warnings.push(`${it.project}: plan ${file} not found`);
        if (it.verdict !== 'barred') { it.verdict = 'question'; if (!it.reasons.includes('question:plan-not-found')) it.reasons.push('question:plan-not-found'); }
        continue;
      }
      if (!it.planRef) it.planRef = { file, specApproved: r.specApproved };
      if (!r.specApproved && it.verdict !== 'barred') {
        it.verdict = 'question';
        if (!it.reasons.includes('question:spec-not-approved')) it.reasons.push('question:spec-not-approved');
      }
    }
  };

  const fromHandoff = (project, path) => {
    const text = readText(path);
    if (text === null) { warnings.push(`${project}: could not read ${basename(path)}`); return false; }
    const parsed = parseNextSteps(text);
    if (!parsed.found) return false;
    const needsMatt = parsed.headingNote !== null && /needs? Matt/i.test(parsed.headingNote);
    for (const s of parsed.items) {
      const it = makeItem(project, s.text, { kind: 'handoff', file: basename(path), n: s.n }, needsMatt ? ['question:needs-matt'] : []);
      applyPlans(it, s.text);
      push(it);
    }
    return true;
  };

  for (const project of projects) {
    const dir = join(homeDir, '.claude', 'handoffs', project);
    const files = listMd(dir, nowMs, maxAgeMs, warnings, project);
    if (files === null) { warnings.push(`${project}: no handoff folder`); continue; }
    const handoffFiles = files.filter((f) => !SKIP_PREFIX.test(f.name));
    let got = false;
    for (const f of handoffFiles) { if (fromHandoff(project, f.path)) { got = true; break; } }
    if (!got) warnings.push(`${project}: no handoff with Next steps within ${maxAgeDays} days`);
    const ledger = files.find((f) => /^ledger-/i.test(f.name));
    if (ledger) {
      const text = readText(ledger.path);
      if (text === null) warnings.push(`${project}: could not read ${ledger.name}`);
      else {
        for (const t of parseLedgerTodos(text)) {
          const it = makeItem(project, t.text, { kind: 'ledger', file: ledger.name }, t.state === 'pending' ? ['question:needs-matt'] : []);
          applyPlans(it, t.text);
          push(it);
        }
      }
    }
  }

  for (const path of handoffs) {
    const project = projectOfPath(dirname(path), projects, repoRoots);
    if (!project) continue;
    if (!fromHandoff(project, path)) warnings.push(`${project}: handoff ${basename(path)} has no Next steps`);
  }

  for (const path of plans) {
    const project = projectOfPath(path, projects, repoRoots);
    if (!project) continue;
    const file = basename(path);
    const r = checkPlan({ homeDir, repoRoots, project, file });
    const it = makeItem(project, `Execute plan ${file}`, { kind: 'plan', file }, []);
    // The file name is item text, so a barred verdict from the classifier beats the spec result.
    it.kind = 'plan';
    const downgrade = (code) => {
      if (it.verdict === 'barred') return;
      it.verdict = 'question';
      if (!it.reasons.includes(code)) it.reasons.push(code);
    };
    if (!r.found) {
      warnings.push(`${project}: plan ${file} not found`);
      downgrade('question:plan-not-found');
    } else {
      it.planRef = { file, specApproved: r.specApproved };
      if (!r.specApproved) downgrade('question:spec-not-approved');
    }
    push(it);
  }

  return {
    v: 1,
    createdAtMs: nowMs,
    targetWindowStartMs: windowFor(nowMs, window).startMs,
    projects: [...projects],
    warnings,
    items,
  };
}
