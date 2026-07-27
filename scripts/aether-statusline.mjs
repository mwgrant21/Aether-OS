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
// Node builtins only (node:fs, node:path, node:os, node:process) — no imports from
// src/ or electron/, and no npm dependencies. This file is executed by Claude Code
// from an arbitrary working directory with no relationship to this repo's module
// resolution, so a relative import would fail at runtime in a way no test here would
// catch.

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const FALLBACK_LINE = 'Aether OS';
const MAX_LINE_LENGTH = 60;
const MIDDLE_DOT = '·';

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

/** Claude Code's rate-limit window key has varied across versions (seen as both
 *  "5-hour" and "five_hour" in different payload shapes). Check every known
 *  spelling rather than hard-coding one, matching the "never hard-fail on an
 *  unexpected field" posture the rest of this feature takes. */
function findFiveHourWindow(rateLimits) {
  if (rateLimits === null || typeof rateLimits !== 'object') {
    return null;
  }
  const candidateKeys = ['five_hour', '5-hour', 'fiveHour', 'five-hour'];
  for (const key of candidateKeys) {
    const window = rateLimits[key];
    if (window !== null && typeof window === 'object') {
      return window;
    }
  }
  return null;
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

function main() {
  const raw = readStdin();
  const payload = parsePayload(raw);

  if (payload === null) {
    process.stdout.write(`${FALLBACK_LINE}\n`);
    return;
  }

  persistSnapshot(payload);

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

process.exit(0);
