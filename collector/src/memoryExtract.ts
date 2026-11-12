/**
 * Aether OS — Layer 2 write path glue.
 *
 * Design: AETHER_MEMORY_LAYER_2.md §4.1 "Shape". Wires the three pieces
 * built in this plan (prompt builder, tolerant parser) to the already-shipped
 * `applyOps` (memoryStore.ts). This is the file that actually calls a model, so
 * it is OPT-IN and default OFF (#104): index.ts gates both the enqueue and the
 * drain on ~/.aether-os/collector-settings.json (privacy-and-data.md §14).
 *
 * SINGLE-WRITER ENFORCEMENT (§3.1's load-bearing property, exercised here):
 * `writer` is a parameter this module's CALLER supplies -- it is never read
 * from the model's JSON output, which has no writer/identity field in its
 * op shapes at all (see memoryStore.ts's MemoryOp union). applyOps checks
 * every op against `ctx.writer`, so a model that tries to write shared scope
 * while the caller-supplied writer is a private agent gets rejected with
 * `scope_violation` regardless of what it emitted. There is no code path in
 * this file that could make model output override caller-supplied identity.
 *
 * Follows the injected-exec-function convention from fleetPoll.ts
 * (FleetExecFn / defaultFleetExec / pollFleet(..., execFn = defaultFleetExec))
 * so tests never spawn a real `claude` process.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildExtractorPrompt, type ExtractorPromptInput } from './memoryExtractPrompt.js';
import { parseExtractorOutput } from './memoryExtractParser.js';
import type { ApplyResult, MemoryStore, SourceKind } from './memoryStore.js';

const execFileAsync = promisify(execFile);

// The opt-in promises "your Claude account via the claude CLI". An API key
// inherited from the collector's (scheduled-task) environment would silently turn
// that into billed API usage, so these are stripped from the child. Duplicated
// from electron/ptyManager.ts (the collector never imports from electron).
const SCRUBBED_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
// Bedrock / Vertex / Foundry switches (CLAUDE_CODE_USE_BEDROCK, ...): provider billing, not the subscription.
const SCRUBBED_ENV_PREFIXES = ['CLAUDE_CODE_USE_'];
// CLAUDE_CODE_OAUTH_TOKEN is deliberately NOT scrubbed: it is the subscription setup token.

// Exported for the test. Matches case-insensitively: process.env is a plain object once
// copied, but Windows resolves env names case-insensitively, so `Anthropic_Api_Key` would
// still reach the child if only the exact-uppercase spelling were deleted.
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (SCRUBBED_ENV_KEYS.has(upper) || SCRUBBED_ENV_PREFIXES.some((p) => upper.startsWith(p))) delete env[key];
  }
  return env;
}

/**
 * Env for BOTH the `auth status` call and the `-p` call: billing/provider variables scrubbed,
 * auto-memory forced off. Any differently-cased existing key is deleted first so Windows never
 * sees two spellings of the same name. The parent env is not mutated.
 */
export function isolatedExtractEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = scrubbedEnv(source);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') delete env[key];
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

export type ExtractExecFn = (prompt: string) => Promise<{ stdout: string }>;

/** Upper bound for one extraction child; execFile kills it with SIGTERM (err.killed = true). */
export const EXTRACT_TIMEOUT_MS = 90_000;

/** Upper bound for the per-item `claude auth status --json` check. */
export const AUTH_STATUS_TIMEOUT_MS = 15_000;

/** The user's hooks hung the headless child (measured: >90 s hooks on, 27.8 s hooks off). */
export const EXTRACT_CHILD_SETTINGS = '{"disableAllHooks":true}';

/**
 * The call was deliberately not made. `reason` is one of a closed set of fixed strings and is
 * all that ever reaches the log: never err.message, stdout, stderr, a path or prompt text.
 */
export class ExtractRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'ExtractRefusedError';
  }
}

export type AuthStatusFn = () => Promise<{ stdout: string }>;

const AUTH_METHOD_REFUSALS: Readonly<Record<string, string>> = {
  api_key: 'auth_api_key',
  api_key_helper: 'auth_api_key_helper',
  third_party: 'auth_third_party',
  none: 'auth_none',
};

/**
 * Fail-closed subscription gate. Only an exit-0 `claude auth status --json` whose `authMethod` is
 * exactly `claude.ai` or `oauth_token` returns; everything else throws ExtractRefusedError.
 * Exact-match and case-sensitive on purpose (allow-list, not deny-list).
 * UNVERIFIED without a model call: that `auth status` makes no model call, and that its
 * `authMethod` is the credential a later `-p` run actually uses. It also cannot be given
 * --setting-sources, so a user with an apiKeyHelper only in ~/.claude/settings.json is refused
 * (auth_api_key_helper) even though the child excludes user settings; that false refusal is accepted.
 */
export async function checkSubscriptionAuth(authStatus: AuthStatusFn): Promise<void> {
  let stdout: unknown;
  try {
    stdout = (await authStatus()).stdout;
  } catch (err) {
    // err may be undefined/null/a string: optional chaining, never a TypeError that skips the refusal.
    const e = err as { killed?: unknown; code?: unknown } | null | undefined;
    if (e?.killed === true) throw new ExtractRefusedError('auth_status_timeout');
    if (typeof e?.code === 'number') throw new ExtractRefusedError('auth_status_exit');
    throw new ExtractRefusedError('auth_status_error');
  }

  let method: unknown;
  try {
    const parsed: unknown = JSON.parse(stdout as string);
    method = typeof parsed === 'object' && parsed !== null ? (parsed as { authMethod?: unknown }).authMethod : undefined;
  } catch {
    method = undefined;
  }
  if (typeof method !== 'string') throw new ExtractRefusedError('auth_status_unparseable');
  if (method === 'claude.ai' || method === 'oauth_token') return;
  throw new ExtractRefusedError(Object.hasOwn(AUTH_METHOD_REFUSALS, method) ? AUTH_METHOD_REFUSALS[method] : 'auth_method_unknown');
}

export interface ExtractExecDeps {
  authStatus?: AuthStatusFn;
}

/** The real call: a cheap headless model invocation, no interactive session. */
export async function defaultExtractExec(prompt: string, deps: ExtractExecDeps = {}): Promise<{ stdout: string }> {
  const authStatus: AuthStatusFn =
    deps.authStatus ??
    (() =>
      execFileAsync('claude', ['auth', 'status', '--json'], {
        env: isolatedExtractEnv(),
        windowsHide: true,
        timeout: AUTH_STATUS_TIMEOUT_MS,
      }));
  await checkSubscriptionAuth(authStatus);

  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--model', 'haiku', '--output-format', 'text', '--settings', EXTRACT_CHILD_SETTINGS],
    { env: isolatedExtractEnv(), windowsHide: true, timeout: EXTRACT_TIMEOUT_MS }
  );
  return { stdout };
}

export interface RunExtractorInput {
  store: MemoryStore;
  /** SHARED_WRITER for a shared-scope proposal, or the agent's own id. Never derived from model output. */
  writer: string;
  sourceKind: SourceKind;
  sourceRunId?: string | null;
  runSummary: ExtractorPromptInput['runSummary'];
  existingMemories: ExtractorPromptInput['existingMemories'];
}

export interface RunExtractorResult extends ApplyResult {
  /** Set when the model's output could not be parsed as a clean JSON array. `rejected` stays [] in that case: an unparseable response never reaches applyOps at all. */
  parseError: string | null;
}

function emptyApplyResult(): ApplyResult {
  return { added: 0, updated: 0, superseded: 0, revised: 0, touched: 0, rejected: [] };
}

export async function runExtractor(
  input: RunExtractorInput,
  execFn: ExtractExecFn = defaultExtractExec,
): Promise<RunExtractorResult> {
  const prompt = buildExtractorPrompt({
    writer: input.writer,
    runSummary: input.runSummary,
    existingMemories: input.existingMemories,
  });

  let stdout: string;
  try {
    stdout = (await execFn(prompt)).stdout;
  } catch (err) {
    if (err instanceof ExtractRefusedError) {
      return { ...emptyApplyResult(), parseError: `exec_refused: ${err.reason}` };
    }
    // Never err.message / err.cmd: execFile puts the full prompt (run text) in both.
    const e = err as { killed?: unknown; code?: unknown } | null;
    const reason =
      e?.killed === true
        ? 'timeout'
        : typeof e?.code === 'string' || typeof e?.code === 'number'
          ? String(e.code)
          : 'error';
    return { ...emptyApplyResult(), parseError: `exec_failed: ${reason}` };
  }

  const { ops, parseError } = parseExtractorOutput(stdout);
  if (parseError) {
    return { ...emptyApplyResult(), parseError };
  }

  const applyResult = input.store.applyOps(ops, {
    writer: input.writer,
    sourceKind: input.sourceKind,
    sourceRunId: input.sourceRunId ?? null,
  });
  return { ...applyResult, parseError: null };
}
