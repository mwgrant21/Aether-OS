#!/usr/bin/env node
// Aether OS hook event emitter.
//
// Installed as the `command` for PreToolUse/PostToolUse/Notification/Stop hooks
// (collector/src/hookInstaller.ts wires this up). Claude Code invokes this on
// every matching event, passing a JSON payload on stdin.
//
// HARD REQUIREMENT: this must never throw, never exit non-zero, and never write
// to stderr, under any input whatsoever -- a bug here degrades the user's live
// coding session, not just this app. Mirrors aether-statusline.mjs's exact
// discipline: every fallible step individually guarded, one last-resort catch
// around main().
//
// Node builtins only -- no imports from src/ or electron/ or collector/, and no
// npm dependencies. Executed by Claude Code from an arbitrary working directory.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const FALLBACK_SESSION_FILE = 'unknown-session';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractSessionId(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  } catch {
    // Malformed JSON -- fall through to the fallback file below.
  }
  return FALLBACK_SESSION_FILE;
}

function appendToSpool(sessionId, rawLine) {
  try {
    const spoolDir = join(homedir(), '.aether-os', 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, `${sessionId}.jsonl`);
    // A single appendFileSync call is not cross-process-atomic against another
    // concurrent writer to the SAME session file, but Claude Code invokes hooks
    // for one session serially (never two hook processes for the same
    // session_id at once), so this is safe in practice -- unlike the
    // statusline script's single shared target file, each session has its own.
    appendFileSync(spoolFile, rawLine.trimEnd() + '\n', 'utf8');
  } catch {
    // Intentionally swallowed: a spool-write failure must never surface to
    // Claude Code as a hook error. The event is simply lost this one time.
  }
}

function main() {
  const raw = readStdin();
  if (raw.trim().length === 0) return; // nothing to append

  const sessionId = extractSessionId(raw);
  appendToSpool(sessionId, raw);
}

try {
  main();
} catch {
  // Absolute last resort: something above threw despite every internal guard.
  // Still must never throw uncaught or exit non-zero.
}

// No explicit process.exit(0): nothing async is pending after main() returns,
// so the process exits 0 on its own, same reasoning as aether-statusline.mjs.
