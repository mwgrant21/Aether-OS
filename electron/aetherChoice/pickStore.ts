import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomically } from '../atomicWrite';
import { LAUNCH_EFFORTS, MODEL_ALIASES } from '../../src/shared/aetherChoice/types';
import type { ModelAlias, Pick, PickSource, PickTrigger } from '../../src/shared/aetherChoice/types';
import type { BudgetLevel } from '../../src/shared/aetherChoice/pickPolicy';
import type { HaltInfo, QueuedPick, ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';

// Owner of ~/.aether-os/aether-choice-picks.json: {"v":1,"threads":{"<threadId>":{...ThreadPickRecord}}}.
// Enums, numbers, booleans and short strings only: no prompt, reply, transcript or path. Loading is
// field-by-field and fails closed: an unknown field is dropped, a malformed record is dropped alone,
// and a bad file reads as empty. Never touches ~/.claude.
export const PICKS_FILE = 'aether-choice-picks.json';
export const MAX_PICKS_FILE_BYTES = 64 * 1024;
const MAX_ID = 64;
const MAX_REASON = 200;
const MAX_VERSION = 64;

export function defaultPicksDir(): string {
  return join(homedir(), '.aether-os');
}

const TRIGGERS: readonly PickTrigger[] = ['new-thread', 'miss', 'budget', 'task-class', 'think-harder', 'manual'];
const SOURCES: readonly PickSource[] = ['auto', 'manual'];
const BUDGET_LEVELS: readonly BudgetLevel[] = ['none', 'step', 'floor'];
const OUTCOMES: readonly ThreadPickRecord['outcome'][] = ['none', 'sent', 'confirmed', 'not-applied'];

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

function parsePick(v: unknown): Pick | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const model = oneOf(MODEL_ALIASES, o.model);
  const effort = oneOf(LAUNCH_EFFORTS, o.effort);
  return model && effort ? { model, effort } : undefined;
}

function parseQueued(v: unknown): QueuedPick | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const pick = parsePick(o.pick);
  const reason = shortStr(o.reason, MAX_REASON);
  const trigger = oneOf(TRIGGERS, o.trigger);
  const source = oneOf(SOURCES, o.source);
  if (!pick || reason === undefined || !trigger || !source) return undefined;
  if (typeof o.queuedAt !== 'number' || !Number.isFinite(o.queuedAt)) return undefined;
  return { pick, reason, trigger, source, queuedAt: o.queuedAt };
}

function parseHalt(v: unknown): HaltInfo | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const wanted = parsePick(o.wanted);
  if (!wanted) return undefined;
  if (o.actual === null) return { wanted, actual: null };
  const actual = parsePick(o.actual);
  return actual ? { wanted, actual } : undefined;
}

function parseRecord(id: string, v: unknown): ThreadPickRecord | undefined {
  const o = obj(v);
  if (!o || o.threadId !== id) return undefined;
  const intended = parsePick(o.intended);
  const reason = shortStr(o.reason, MAX_REASON);
  const trigger = oneOf(TRIGGERS, o.trigger);
  const source = oneOf(SOURCES, o.source);
  const lastBudgetLevel = oneOf(BUDGET_LEVELS, o.lastBudgetLevel);
  const outcome = oneOf(OUTCOMES, o.outcome);
  if (!intended || reason === undefined || !trigger || !source || !lastBudgetLevel || !outcome) return undefined;
  if (typeof o.live !== 'boolean' || typeof o.pendingStepDown !== 'boolean') return undefined;

  const claudeVersion = o.claudeVersion === null ? null : shortStr(o.claudeVersion, MAX_VERSION);
  if (claudeVersion === undefined) return undefined;

  // Optional: files written before `launched` existed have no key; fall back to null (= use intended).
  let launched: Pick | null = null;
  if (o.launched !== undefined && o.launched !== null) {
    const p = parsePick(o.launched);
    if (!p) return undefined;
    launched = p;
  }
  let lastConfirmed: Pick | null = null;
  if (o.lastConfirmed !== null) {
    const p = parsePick(o.lastConfirmed);
    if (!p) return undefined;
    lastConfirmed = p;
  }
  let lastLaunchedModel: ModelAlias | null = null;
  if (o.lastLaunchedModel !== null) {
    const m = oneOf(MODEL_ALIASES, o.lastLaunchedModel);
    if (!m) return undefined;
    lastLaunchedModel = m;
  }
  let queue: QueuedPick | null = null;
  if (o.queue !== null) {
    const q = parseQueued(o.queue);
    if (!q) return undefined;
    queue = q;
  }
  let modelPending: ModelAlias | null = null;
  if (o.modelPending !== null) {
    const m = oneOf(MODEL_ALIASES, o.modelPending);
    if (!m) return undefined;
    modelPending = m;
  }
  let pendingSource: PickSource | null = null;
  if (o.pendingSource !== null) {
    const s = oneOf(SOURCES, o.pendingSource);
    if (!s) return undefined;
    pendingSource = s;
  }
  let halted: HaltInfo | null = null;
  if (o.halted !== null) {
    const h = parseHalt(o.halted);
    if (!h) return undefined;
    halted = h;
  }
  return {
    threadId: id,
    claudeVersion,
    live: o.live,
    intended,
    launched,
    lastConfirmed,
    lastLaunchedModel,
    lastBudgetLevel,
    pendingStepDown: o.pendingStepDown,
    reason,
    trigger,
    source,
    queue,
    modelPending,
    pendingSource,
    halted,
    outcome,
  };
}

/** Never throws. Missing, oversize, unparseable or wrong-version file -> {}. Bad entries are dropped one by one. */
export function loadPicks(dir: string): Record<string, ThreadPickRecord> {
  const out: Record<string, ThreadPickRecord> = {};
  try {
    const file = join(dir, PICKS_FILE);
    if (statSync(file).size > MAX_PICKS_FILE_BYTES) return out;
    const root = obj(JSON.parse(readFileSync(file, 'utf8')));
    const threads = obj(root?.threads);
    if (!root || root.v !== 1 || !threads) return out;
    for (const [id, raw] of Object.entries(threads)) {
      if (id.length === 0 || id.length > MAX_ID) continue;
      const rec = parseRecord(id, raw);
      if (rec) out[id] = rec;
    }
  } catch {
    return {};
  }
  return out;
}

/** Writes only the validated shape (re-parsed field by field), so extra properties on a caller's object never reach disk. */
export async function savePicks(dir: string, records: Record<string, ThreadPickRecord>): Promise<void> {
  const threads: Record<string, ThreadPickRecord> = {};
  for (const [id, rec] of Object.entries(records)) {
    const clean = id.length <= MAX_ID ? parseRecord(id, rec) : undefined;
    if (clean) threads[id] = clean;
  }
  mkdirSync(dir, { recursive: true });
  await writeFileAtomically(join(dir, PICKS_FILE), JSON.stringify({ v: 1, threads }));
}
