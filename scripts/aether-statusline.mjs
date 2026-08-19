#!/usr/bin/env node
// Aether OS statusline feed.
//
// This script is installed as Claude Code's `statusLine` command (Task 4 wires it
// up). Claude Code invokes it on every turn, passing a JSON payload on stdin, and
// prints whatever this script writes to stdout as the terminal status line.
//
// HARD REQUIREMENT: this must never throw, never exit non-zero, and never write to
// stderr, under any input whatsoever — a bug here degrades the user's live coding
// session, not just this app. Every step that can fail is individually guarded so a
// problem in one stage (e.g. the file write) cannot prevent the fallback stdout line
// from being printed.
//
// Node builtins only (node:fs, node:path, node:os, node:child_process, node:process)
// — no imports from src/ or electron/, and no npm dependencies. This file is
// executed by Claude Code from an arbitrary working directory with no relationship
// to this repo's module resolution, so a relative import would fail at runtime in a
// way no test here would catch.

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const FALLBACK_LINE = 'Aether OS';
const MAX_LINE_LENGTH = 60;
const MIDDLE_DOT = '·';
const CHAIN_TIMEOUT_MS = 5000;

/** Reads all of stdin synchronously. Returns '' on any failure (closed stdin, no
 *  input piped, read error) rather than throwing. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Parses raw stdin text into a plain object, or null on any failure / non-object
 *  result. Never throws. */
function parsePayload(raw) {
  try {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function safePercentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Looks up the confirmed real payload key for the five-hour rate-limit window
 *  (`rate_limits.five_hour`), guarded the same way every other optional field in
 *  this script is: type-checked, never throwing. */
function findFiveHourWindow(rateLimits) {
  if (rateLimits === null || typeof rateLimits !== 'object') {
    return null;
  }
  const window = rateLimits.five_hour;
  return window !== null && typeof window === 'object' ? window : null;
}

/** Builds the human-readable status line from a parsed payload. Best-effort: any
 *  missing/malformed field is simply omitted from the line rather than failing. */
function buildStatusLine(payload) {
  try {
    const parts = [];

    const model = payload && typeof payload.model === 'object' ? payload.model : null;
    const modelName = model && typeof model.display_name === 'string' ? model.display_name : null;
    parts.push(modelName || 'Claude');

    const rateLimits = payload && typeof payload.rate_limits === 'object' ? payload.rate_limits : null;
    const fiveHourWindow = findFiveHourWindow(rateLimits);
    const fiveHourPct = fiveHourWindow ? safePercentage(fiveHourWindow.used_percentage) : null;
    if (fiveHourPct !== null) {
      parts.push(`5h ${fiveHourPct}%`);
    }

    const contextWindow = payload && typeof payload.context_window === 'object' ? payload.context_window : null;
    const ctxPct = contextWindow ? safePercentage(contextWindow.used_percentage) : null;
    if (ctxPct !== null) {
      parts.push(`ctx ${ctxPct}%`);
    }

    const line = parts.join(` ${MIDDLE_DOT} `);
    if (line.length === 0) {
      return FALLBACK_LINE;
    }
    return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
  } catch {
    return FALLBACK_LINE;
  }
}

/** Atomically persists the payload for the Electron app's file watcher (Task 5) to
 *  pick up: write to a .tmp file in the same directory, then rename over the
 *  target. A direct write to the target path would let the watcher observe a
 *  partially-written (truncated) file mid-write; rename is atomic on the same
 *  filesystem. Failure here must never prevent the stdout line from printing, so
 *  every error is swallowed. */
function persistSnapshot(payload) {
  try {
    const dir = join(homedir(), '.aether-os');
    mkdirSync(dir, { recursive: true });
    const targetPath = join(dir, 'statusline.json');
    const tmpPath = join(dir, 'statusline.json.tmp');
    const record = { ...payload, capturedAtMs: Date.now() };
    writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    // Intentionally swallowed: a persistence failure must not break the statusline
    // output or cause a non-zero exit. Task 5's watcher simply won't see an update.
  }
}

/** Decodes the `--chain <base64>` CLI argument installStatusline embeds when
 *  another statusLine command was already configured (see
 *  statuslineInstaller.ts's statuslineSettingsPatch). Returns null when
 *  absent or undecodable -- never throws. */
function parseChainArg(argv) {
  const idx = argv.indexOf('--chain');
  if (idx === -1 || idx + 1 >= argv.length) {
    return null;
  }
  try {
    const decoded = Buffer.from(argv[idx + 1], 'base64').toString('utf8');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Runs whatever statusLine command was configured before this script was
 *  installed, feeding it the exact same stdin Claude Code gave us, and
 *  returns its trimmed stdout -- or null on any failure (non-zero exit,
 *  spawn error, timeout, empty output). Bounded by CHAIN_TIMEOUT_MS so a
 *  hung chained command can never hang the user's statusline render; never
 *  throws, matching this script's hard contract. */
function runChainedCommand(command, rawStdin) {
  try {
    const result = spawnSync(command, {
      input: rawStdin,
      shell: true,
      encoding: 'utf8',
      timeout: CHAIN_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function main() {
  const raw = readStdin();
  const payload = parsePayload(raw);

  if (payload === null) {
    process.stdout.write(`${FALLBACK_LINE}\n`);
    return;
  }

  persistSnapshot(payload);

  const chainCommand = parseChainArg(process.argv.slice(2));
  if (chainCommand) {
    const chainedLine = runChainedCommand(chainCommand, raw);
    if (chainedLine !== null) {
      // Print the chained tool's own line verbatim -- Aether's payload
      // capture above already happened as a side effect, invisible to what
      // the user sees in their terminal.
      process.stdout.write(`${chainedLine}\n`);
      return;
    }
    // Chained command failed, timed out, or printed nothing -- fall through
    // to Aether's own line so the statusline never goes blank.
  }

  const line = buildStatusLine(payload);
  process.stdout.write(`${line}\n`);
}

try {
  main();
} catch {
  // Absolute last resort: something above threw despite every internal guard.
  // Still must never throw uncaught, exit non-zero, or touch stderr.
  try {
    process.stdout.write(`${FALLBACK_LINE}\n`);
  } catch {
    // Nothing further can be done; fall through to a clean exit regardless.
  }
}

// No explicit process.exit(0) here: on POSIX, process.exit() does not flush
// pending async writes to a piped stdout, and there is nothing else left on
// the event loop after main() returns, so the process exits 0 on its own --
// an explicit exit call here buys nothing and is a truncation hazard.
