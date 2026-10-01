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
const SCRUBBED_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

export type ExtractExecFn = (prompt: string) => Promise<{ stdout: string }>;

/** The real call: a cheap headless model invocation, no interactive session. */
export async function defaultExtractExec(prompt: string): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', prompt, '--model', 'haiku', '--output-format', 'text'],
    { env: scrubbedEnv(), windowsHide: true }
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
    return {
      ...emptyApplyResult(),
      parseError: `exec_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
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
