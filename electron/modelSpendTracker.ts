//
// Tracks Aether's own model spend (chatCore calls only -- this has nothing
// to do with, and cannot see, spend from Claude Code sessions run in
// Aether's embedded terminal). Same JSON-file persistence shape as
// optimizeState.ts. Aether cannot query the account's remaining balance --
// no API exposes it -- so this can only ever answer "how much have *we*
// spent," never "how much is left." See docs/roadmap.md §3.4.
//
// Headline generation used to be a second, billed call site (Haiku) tracked
// here too; it was retired in favor of a deterministic, free formatter (see
// electron/headlineGenerator.ts and modelPolicy.ts's header comment) as part
// of the "Aether should not cost a user money" decision. `chat` is the only
// tier left, and Chat is the only remaining call site.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveModel } from '../src/shared/modelPolicy';

// USD per million tokens, input/output split. Keyed by resolveModel() rather
// than a literal string so this table can never drift from modelPolicy.ts's
// single source of truth, and so it doesn't itself become a model-ID literal
// the enforcement test would (correctly) flag.
const RATES_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  [resolveModel('chat')]: { input: 15, output: 75 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES_PER_MILLION_TOKENS[model];
  if (!rate) return 0;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

export function sanitizeSpendState(raw: unknown): Record<string, number> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [monthKey, usd] of Object.entries(src)) {
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) out[monthKey] = usd;
  }
  return out;
}

async function writeSpendState(statePath: string, state: Record<string, number>): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// Distinguishes "no state yet" (legitimate: ENOENT, first run) from "state
// exists but can't be trusted" (corrupt JSON, permission error, or any other
// read failure). The former returns {} -- there is genuinely nothing to
// report. The latter THROWS rather than silently returning {}: swallowing it
// here would make a locked/corrupt file read as "$0 spent this month" to
// every caller, silently resetting the self-imposed spend ceiling to zero
// for as long as the file stays unreadable. Callers (main.ts's
// modelCallsCurrentlyPermitted) decide the fail-open/fail-closed policy;
// this function's job is only to tell the truth about which case occurred.
export async function loadSpendState(statePath: string): Promise<Record<string, number>> {
  let raw: string;
  try {
    raw = await fsp.readFile(statePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return sanitizeSpendState(JSON.parse(raw));
  } catch (err) {
    throw new Error(`model spend state at ${statePath} is corrupt/unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Adds usd to monthKey's running total and persists it, returning the new
// total so callers can check it against the ceiling without a second read.
export async function recordSpend(statePath: string, monthKey: string, usd: number): Promise<number> {
  const state = await loadSpendState(statePath);
  const next = (state[monthKey] ?? 0) + usd;
  state[monthKey] = next;
  await writeSpendState(statePath, state);
  return next;
}

export const MONTHLY_SPEND_CEILING_USD = 10;
export const DEGRADE_THRESHOLD_RATIO = 0.8;

export type SpendGate = 'ok' | 'degrade' | 'blocked';

// Pure decision function. Never throws, never touches the network or the
// account balance -- degradation is graceful (calls still work, UI warns)
// until the self-imposed ceiling, at which point Aether stops calling out
// on its own rather than erroring.
export function spendGate(monthTotalUsd: number, ceilingUsd: number = MONTHLY_SPEND_CEILING_USD): SpendGate {
  if (monthTotalUsd >= ceilingUsd) return 'blocked';
  if (monthTotalUsd >= ceilingUsd * DEGRADE_THRESHOLD_RATIO) return 'degrade';
  return 'ok';
}
