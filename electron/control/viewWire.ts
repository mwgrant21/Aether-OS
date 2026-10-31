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

const DASH_ALARMS = ['ok', 'warn', 'crit'];
const DASH_ETA_KINDS = ['none', 'now', 'secs'];
const DASH_ETA_SOURCES = ['scan', 'live', 'stale'];
const DASH_READINESS_KEYS = ['desktop', 'terminal', 'statusline', 'collector'];

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;
/** null stays null; anything else must be a finite non-negative number (NaN, Infinity and negatives are rejected: undefined = invalid). */
const nullableNum = (x: unknown, places: number): number | null | undefined => (x === null ? null : num(x) ? round(x, places) : undefined);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * `dash`: {computedAtMs, live, alarm, ratePerMin, kpis:{monthTokens, todayUsd, budgetLeftPct, capM, eta}, readiness,
 * recap, strip}. Built in the renderer, so nothing in it is trusted: every field is rebuilt here from enums, booleans
 * and non-negative numbers; stray keys (and so any free text or cfg field) are dropped; null stays null (not measured,
 * never 0); a NaN, negative or out-of-range number, an unknown enum or an inconsistent eta makes the whole payload null.
 * No text field exists in this payload.
 */
export function encodeDashView(p: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!isRecord(p) || !count(p.computedAtMs) || typeof p.live !== 'boolean' || !oneOf(DASH_ALARMS, p.alarm)) return null;
  const ratePerMin = nullableNum(p.ratePerMin, 2);
  const k = p.kpis;
  if (ratePerMin === undefined || !isRecord(k) || !isRecord(k.eta)) return null;
  const monthTokens = nullableNum(k.monthTokens, 0);
  const todayUsd = nullableNum(k.todayUsd, 4);
  const budgetLeftPct = nullableNum(k.budgetLeftPct, 2);
  const e = k.eta;
  const secs = nullableNum(e.secs, 0);
  const resetsInMs = nullableNum(e.resetsInMs, 0);
  if (monthTokens === undefined || todayUsd === undefined || budgetLeftPct === undefined || (budgetLeftPct !== null && budgetLeftPct > 100)) return null;
  if (!num(k.capM) || k.capM <= 0 || !oneOf(DASH_ETA_KINDS, e.kind) || !oneOf(DASH_ETA_SOURCES, e.source)) return null;
  if (secs === undefined || resetsInMs === undefined || (e.kind === 'secs') !== (secs !== null)) return null;
  if (!Array.isArray(p.readiness) || p.readiness.length > DASH_READINESS_KEYS.length) return null;
  const seen = new Set<string>();
  const readiness: Record<string, unknown>[] = [];
  for (const r of p.readiness) {
    if (!isRecord(r) || !oneOf(DASH_READINESS_KEYS, r.key) || seen.has(r.key) || typeof r.met !== 'boolean' || typeof r.glows !== 'boolean') return null;
    if (!(r.atMs === null || count(r.atMs))) return null;
    seen.add(r.key);
    readiness.push({ key: r.key, met: r.met, glows: r.glows, atMs: r.atMs });
  }
  let recap: Record<string, unknown> | null = null;
  if (p.recap !== null) {
    const r = p.recap;
    if (!isRecord(r) || !count(r.dispatches) || !count(r.anomaliesDetected) || !count(r.anomaliesCleared) || !count(r.tokensBurned)) return null;
    recap = { dispatches: r.dispatches, anomaliesDetected: r.anomaliesDetected, anomaliesCleared: r.anomaliesCleared, tokensBurned: r.tokensBurned };
  }
  const s = p.strip;
  if (!isRecord(s) || !count(s.agents) || !count(s.alerts) || !count(s.memory)) return null;
  return {
    computedAtMs: p.computedAtMs,
    live: p.live,
    alarm: p.alarm,
    ratePerMin,
    kpis: { monthTokens, todayUsd, budgetLeftPct, capM: round(k.capM, 4), eta: { kind: e.kind, secs, source: e.source, resetsInMs } },
    readiness,
    recap,
    strip: { agents: s.agents, alerts: s.alerts, memory: s.memory },
  };
}

export const ANALYTICS_DESC_CAP = 80;
export const ANALYTICS_TYPE_CAP = 40;
export const ANALYTICS_COMMAND_CAP = 24;
export const ANALYTICS_MAX_LONGEST = 8;
export const ANALYTICS_MAX_BURN = 5;
export const ANALYTICS_MAX_COMMANDS = 5;

/**
 * `analytics`: {computedAtMs, logs:{success,info,denied,other}, longest:[{type,description,startedAtMs}] (at most 8),
 * burn:[{type,description,tokens,toolUses,durationMs}] (at most 5), commands:[{name,count}] (at most 5)}. Built in the
 * renderer, so rebuilt here field by field: descriptions are masked then capped at 80, types at 40, a command name
 * (the first word of one typed command, never a command line) at 24. A command name with whitespace in it, a
 * non-string, or any bad number makes the whole payload null; lists beyond their caps are cut. Stray keys (a prompt,
 * a raw log, a full command) are dropped.
 */
export function encodeAnalyticsView(p: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!isRecord(p) || !count(p.computedAtMs) || !isRecord(p.logs) || !Array.isArray(p.longest) || !Array.isArray(p.burn) || !Array.isArray(p.commands)) return null;
  const l = p.logs;
  if (!count(l.success) || !count(l.info) || !count(l.denied) || !count(l.other)) return null;
  const longest: Record<string, unknown>[] = [];
  for (const r of p.longest.slice(0, ANALYTICS_MAX_LONGEST)) {
    if (!isRecord(r)) return null;
    const type = text(r.type, ANALYTICS_TYPE_CAP);
    const description = text(r.description, ANALYTICS_DESC_CAP);
    if (type === null || description === null || !count(r.startedAtMs)) return null;
    longest.push({ type, description, startedAtMs: r.startedAtMs });
  }
  const burn: Record<string, unknown>[] = [];
  for (const r of p.burn.slice(0, ANALYTICS_MAX_BURN)) {
    if (!isRecord(r)) return null;
    const type = text(r.type, ANALYTICS_TYPE_CAP);
    const description = text(r.description, ANALYTICS_DESC_CAP);
    const toolUses = nullableNum(r.toolUses, 0);
    if (type === null || description === null || !num(r.tokens) || !num(r.durationMs) || toolUses === undefined) return null;
    burn.push({ type, description, tokens: round(r.tokens, 0), toolUses, durationMs: round(r.durationMs, 0) });
  }
  const commands: Record<string, unknown>[] = [];
  for (const r of p.commands.slice(0, ANALYTICS_MAX_COMMANDS)) {
    if (!isRecord(r) || typeof r.name !== 'string' || r.name.length === 0 || /\s/.test(r.name) || !count(r.count)) return null;
    const name = text(r.name, ANALYTICS_COMMAND_CAP);
    if (name === null) return null;
    commands.push({ name, count: r.count });
  }
  return { computedAtMs: p.computedAtMs, logs: { success: l.success, info: l.info, denied: l.denied, other: l.other }, longest, burn, commands };
}

export const AGENTS_DESC_CAP = 120;
export const AGENTS_HEADLINE_CAP = 120;
export const AGENTS_NARRATION_CAP = 160;
export const AGENTS_DETAIL_CAP = 120;
export const AGENTS_PROMPT_CAP = 1200;
export const AGENTS_TYPE_CAP = 40;
export const AGENTS_MODEL_CAP = 40;
export const AGENTS_MAX_RUNNING = 30;
export const AGENTS_MAX_DONE = 20;
const AGENTS_ANOMALY_KINDS = ['reReadLoop', 'writeDeleteRewrite', 'zeroEditBurn', 'stalledPermission'];
const AGENTS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mask the raw text, then reduce any path-shaped token to its last segment, then cap (an anomaly detail can open with a file path). */
function detailText(x: unknown, n: number): string | null {
  if (typeof x !== 'string') return null;
  const masked = maskSecrets(x);
  // The detectors emit "<path or label> <fixed suffix>". Paths may contain spaces, so cut at the suffix and keep only
  // what follows the head's last separator; other shapes fall back to a per-token pass.
  const m = /^([\s\S]*?) (read \d+ times|written \d+ times in 5min|open for \d+s)$/.exec(masked);
  if (m) {
    const head = m[1].replace(/^[\s'"]+|[\s'"]+$/g, '');
    const base = head.slice(Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\')) + 1).replace(/^[\s'"]+|[\s'"]+$/g, '');
    return text(`${base} ${m[2]}`.trim(), n);
  }
  return text(masked.replace(/[^\s'"]*[\\/][^\s'"]*/g, (t) => t.split(/[\\/]/).filter(Boolean).pop() ?? ''), n);
}

/** Already-encoded fleet and timeline rows (encodeFleetRows / encodeTimelineRows output); null = collector absent or unreadable. */
export interface AgentsDiagWire {
  fleet: Record<string, unknown>[] | null;
  timeline: Record<string, unknown>[] | null;
}

export const AGENTS_MAX_FLEET = 50;
export const AGENTS_MAX_TIMELINE = 60;
export const AGENTS_FLEET_TITLE_CAP = 60;
export const AGENTS_FLEET_NAME_CAP = 60;
export const AGENTS_FLEET_KIND_CAP = 40;
export const AGENTS_LABEL_CAP = 80;
const FLEET_STATUSES = ['busy', 'idle'];
const FLEET_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Text after the last path separator (either kind), exactly as DispatchTimeline's split(/[\\/]/).pop(): a trailing separator leaves ''. A spaced directory name never survives. */
const afterLastSep = (x: string): string => x.slice(Math.max(x.lastIndexOf('/'), x.lastIndexOf('\\')) + 1);
/** Last path segment, ignoring trailing separators (a project path may be written with one). */
const lastSegment = (x: string): string => afterLastSep(x.replace(/[\\/\s]+$/, ''));

/**
 * Fleet rows for the `agents` view: [{key,title,name,startedAtMs,status,kind,pid}] oldest first (as FleetCard sorts), at
 * most 50 (the oldest). Input rows carry `key` (an opaque hash made by the caller) and `projectName`, which becomes
 * `title` (masked, reduced to its last path segment, cap 60). `name` (the session name) is masked, path tokens reduced,
 * cap 60; kind cap 40. Rebuilt field by field, so stray keys (sessionId, cwd, any path) are dropped. A row with a bad key,
 * start time, status or pid is dropped, not the payload; a duplicate key keeps the first. Not an array -> null; a
 * non-empty input with no valid row -> null (never an empty list that would read as "no other sessions").
 */
export function encodeFleetRows(rows: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(rows)) return null;
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isRecord(r) || typeof r.key !== 'string' || !FLEET_KEY_RE.test(r.key) || seen.has(r.key) || !count(r.startedAtMs) || !oneOf(FLEET_STATUSES, r.status)) continue;
    if (r.pid !== null && !count(r.pid)) continue;
    if (typeof r.projectName !== 'string') continue;
    const title = text(lastSegment(maskSecrets(r.projectName)), AGENTS_FLEET_TITLE_CAP);
    const name = detailText(r.name, AGENTS_FLEET_NAME_CAP);
    const kind = text(r.kind, AGENTS_FLEET_KIND_CAP);
    if (title === null || name === null || kind === null) continue;
    seen.add(r.key);
    out.push({ key: r.key, title, name, startedAtMs: r.startedAtMs, status: r.status, kind, pid: r.pid });
  }
  if (rows.length > 0 && out.length === 0) return null;
  out.sort((a, b) => (a.startedAtMs as number) - (b.startedAtMs as number));
  return out.slice(0, AGENTS_MAX_FLEET);
}

const timeMs = (x: unknown): number | null => (num(x) && Number.isSafeInteger(Math.round(x)) ? Math.round(x) : null);

/**
 * Timeline rows for the `agents` view: [{k,atMs,label,tokens,toolUses,durationMs}] newest first (as DispatchTimeline
 * sorts), at most 60 (the newest). Input is the collector's diagnostics snapshot {toolCalls,dispatches,anomalies}.
 * k is tool|dispatch|anomaly (the desktop's toolCall maps to tool). label is one string, masked FIRST, then reduced, then
 * capped at 80: a tool call is "<toolName> <file BASENAME>" (a spaced directory never survives), an anomaly is
 * "<kind>: <detail>" with the detail reduced like an anomaly detail, a dispatch is "Agent" (the desktop row shows no
 * description). tokens/toolUses/durationMs are set on dispatches only (null elsewhere, and null when not measured).
 * Rebuilt field by field: filePathRel, toolUseId, sessionId, agentId and every other key never reach the wire. A row with
 * a bad time or number is dropped. Not a snapshot -> null; all three lists empty -> []; rows present but none valid -> null.
 */
export function encodeTimelineRows(snap: unknown): Record<string, unknown>[] | null {
  if (!isRecord(snap) || !Array.isArray(snap.toolCalls) || !Array.isArray(snap.dispatches) || !Array.isArray(snap.anomalies)) return null;
  const items: Record<string, unknown>[] = [];
  const total = snap.toolCalls.length + snap.dispatches.length + snap.anomalies.length;
  for (const t of snap.toolCalls) {
    if (!isRecord(t) || typeof t.toolName !== 'string') continue;
    const at = timeMs(t.closedAtMs);
    if (at === null) continue;
    const base = typeof t.filePathRel === 'string' ? afterLastSep(maskSecrets(t.filePathRel)).trim() : '';
    const label = detailText(base ? `${t.toolName} ${base}` : t.toolName, AGENTS_LABEL_CAP);
    if (label === null) continue;
    items.push({ k: 'tool', atMs: at, label, tokens: null, toolUses: null, durationMs: null });
  }
  for (const d of snap.dispatches) {
    if (!isRecord(d)) continue;
    const at = timeMs(d.endedAtMs);
    const tokens = nullableNum(d.tokens, 0);
    const toolUses = nullableNum(d.toolUses, 0);
    const durationMs = nullableNum(d.durationMs, 0);
    if (at === null || tokens === undefined || toolUses === undefined || durationMs === undefined) continue;
    items.push({ k: 'dispatch', atMs: at, label: 'Agent', tokens, toolUses, durationMs });
  }
  for (const a of snap.anomalies) {
    if (!isRecord(a)) continue;
    const at = timeMs(a.detectedAtMs);
    const kind = detailText(a.kind, AGENTS_TYPE_CAP);
    const detail = detailText(a.detail, AGENTS_LABEL_CAP);
    if (at === null || kind === null || detail === null) continue;
    const label = text(`${kind}: ${detail}`, AGENTS_LABEL_CAP);
    if (label === null) continue;
    items.push({ k: 'anomaly', atMs: at, label, tokens: null, toolUses: null, durationMs: null });
  }
  if (total > 0 && items.length === 0) return null;
  items.sort((a, b) => (b.atMs as number) - (a.atMs as number));
  return items.slice(0, AGENTS_MAX_TIMELINE);
}

/**
 * `agents`: {computedAtMs, running:[{id,type,description,startedAtMs,model,headline,narration,needsInput,anomaly,prompt}]
 * (at most 30), done:[{id,type,description,startedAtMs,tokens,toolUses,durationMs,headline}] (at most 20), fleet, timeline}.
 * fleet and timeline are NEVER read from `p` (the renderer cannot supply them): they come from the second argument, the
 * output of encodeFleetRows / encodeTimelineRows built from the collector in main (null = collector absent or unreadable,
 * [] = present but empty), and default to null. The roster is built in the renderer, so rebuilt field by field:
 * every text field is masked then capped (description 120, headline 120, narration 160, anomaly detail 120, prompt 1200,
 * type 40, model 40); an anomaly detail also has any path reduced to its last segment. An id must be an opaque safe
 * string (letters, digits, _ and -, up to 64) and needsInput must equal "anomaly present". Narration and model are null
 * when unknown, usage numbers are null when not measured (never 0). Stray keys are dropped; a bad id, enum, number,
 * shape or needsInput mismatch makes the whole payload null; lists beyond their caps are cut.
 */
export function encodeAgentsView(p: Record<string, unknown> | null, diag: AgentsDiagWire = { fleet: null, timeline: null }): Record<string, unknown> | null {
  if (!isRecord(p) || !count(p.computedAtMs) || !Array.isArray(p.running) || !Array.isArray(p.done)) return null;
  const running: Record<string, unknown>[] = [];
  for (const r of p.running.slice(0, AGENTS_MAX_RUNNING)) {
    if (!isRecord(r) || typeof r.id !== 'string' || !AGENTS_ID_RE.test(r.id) || typeof r.needsInput !== 'boolean' || !count(r.startedAtMs)) return null;
    const type = text(r.type, AGENTS_TYPE_CAP);
    const description = text(r.description, AGENTS_DESC_CAP);
    const headline = text(r.headline, AGENTS_HEADLINE_CAP);
    const prompt = text(r.prompt, AGENTS_PROMPT_CAP);
    const model = nullableText(r.model, AGENTS_MODEL_CAP);
    const narration = nullableText(r.narration, AGENTS_NARRATION_CAP);
    if (type === null || description === null || headline === null || prompt === null || model === undefined || narration === undefined) return null;
    let anomaly: Record<string, unknown> | null = null;
    if (r.anomaly !== null) {
      const a = r.anomaly;
      if (!isRecord(a) || !oneOf(AGENTS_ANOMALY_KINDS, a.kind)) return null;
      const detail = detailText(a.detail, AGENTS_DETAIL_CAP);
      if (detail === null) return null;
      anomaly = { kind: a.kind, detail };
    }
    if (r.needsInput !== (anomaly !== null)) return null;
    running.push({ id: r.id, type, description, startedAtMs: r.startedAtMs, model, headline, narration, needsInput: r.needsInput, anomaly, prompt });
  }
  const done: Record<string, unknown>[] = [];
  for (const r of p.done.slice(0, AGENTS_MAX_DONE)) {
    if (!isRecord(r) || typeof r.id !== 'string' || !AGENTS_ID_RE.test(r.id) || !count(r.startedAtMs)) return null;
    const type = text(r.type, AGENTS_TYPE_CAP);
    const description = text(r.description, AGENTS_DESC_CAP);
    const headline = text(r.headline, AGENTS_HEADLINE_CAP);
    const tokens = nullableNum(r.tokens, 0);
    const toolUses = nullableNum(r.toolUses, 0);
    const durationMs = nullableNum(r.durationMs, 0);
    if (type === null || description === null || headline === null || tokens === undefined || toolUses === undefined || durationMs === undefined) return null;
    done.push({ id: r.id, type, description, startedAtMs: r.startedAtMs, tokens, toolUses, durationMs, headline });
  }
  return { computedAtMs: p.computedAtMs, running, done, fleet: diag.fleet, timeline: diag.timeline };
}
