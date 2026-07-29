#!/usr/bin/env node
// Aether OS PermissionRequest hook script.
//
// Installed as the `command` for the PermissionRequest hook
// (collector/src/hookInstaller.ts wires this up). Claude Code invokes this
// synchronously before a risky tool call executes, passing a JSON payload on
// stdin, and blocks waiting for this process to exit (up to 600s).
//
// Contract (see docs/superpowers/specs/2026-07-28-closing-the-loop-design.md,
// "Verified real infrastructure"):
//   stdin:  { session_id, permission_mode, tool_name, tool_input, tool_use_id }
//   stdout (exit 0): { hookSpecificOutput: { hookEventName: "PermissionRequest",
//                       decision: { behavior: "allow" | "deny", updatedInput? } } }
//   Falling through (session mismatch, app not running, any failure) means:
//   exit 0 with NO stdout, letting Claude Code's native prompt/hooks take over.
//
// HARD REQUIREMENT: this must never throw, never hang, never exit non-zero.
// A bug here degrades the user's live coding session. Mirrors
// aether-hook-emit.mjs's discipline: every fallible step individually
// guarded, one last-resort catch around main().
//
// Node builtins only -- no imports from src/ or electron/ or collector/, and
// no npm dependencies (this is a standalone process Claude Code spawns
// directly with `node "<path>"`, no build step, no module resolution beyond
// plain Node). The own-session.json read logic below intentionally mirrors
// collector/src/ownSessionFile.ts#readOwnSessionId rather than importing it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import process from 'node:process';

// "is the app even reachable" -- fail fast. Matches the design spec's
// explicit ~500ms target (docs/superpowers/specs/2026-07-28-closing-the-loop-design.md,
// line 29: "attempts a short-timeout (~500ms) connection to the local
// server"). An earlier draft used 1500ms with no real justification; testing
// showed 500ms is plenty for a same-machine loopback TCP handshake -- this
// only guards the connect phase (cleared on the socket 'connect' event), not
// the full response wait, which has its own 120s DECISION_TIMEOUT_MS below.
const CONNECT_TIMEOUT_MS = 500;
const DECISION_TIMEOUT_MS = 120000; // full wait for a real user decision

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readOwnSessionId(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sessionId = parsed.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

function readPort(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

// Resolves with the parsed decision, or null if the server was unreachable,
// timed out, or returned something unusable. Never rejects.
function postPermissionRequest(port, toolName, toolInput) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = JSON.stringify({ toolName, toolInput });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/permission-request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && (parsed.behavior === 'allow' || parsed.behavior === 'deny')) {
              done(parsed);
            } else {
              done(null);
            }
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      }
    );

    req.on('error', () => done(null));

    // Fail fast if the TCP connect itself doesn't complete quickly (nothing
    // listening on the port -- "app isn't open"). Cleared once connected so
    // it never fires against a slow-to-decide-but-connected server, which
    // gets the full DECISION_TIMEOUT_MS below instead.
    const connectTimer = setTimeout(() => {
      req.destroy();
      done(null);
    }, CONNECT_TIMEOUT_MS);
    req.once('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });

    // Overall safety net covering the full decision wait, independent of the
    // per-socket connect timeout above.
    const overallTimer = setTimeout(() => {
      req.destroy();
      done(null);
    }, DECISION_TIMEOUT_MS);
    overallTimer.unref?.();

    req.end(body);
  });
}

function toHookOutput(decision) {
  const out = { behavior: decision.behavior };
  if (decision.updatedInput !== undefined) out.updatedInput = decision.updatedInput;
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: out,
    },
  };
}

async function main() {
  const raw = readStdin();
  if (raw.trim().length === 0) return; // fall through: nothing to act on

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // fall through: malformed input
  }
  if (!payload || typeof payload !== 'object') return;

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  if (!sessionId || !toolName) return; // fall through: unusable payload

  const aetherDir = join(homedir(), '.aether-os');
  const ownSessionId = readOwnSessionId(join(aetherDir, 'own-session.json'));
  if (!ownSessionId || ownSessionId !== sessionId) return; // fall through: not our session

  const port = readPort(join(aetherDir, 'permission-server-port'));
  if (!port) return; // fall through: app not running / no port file

  const decision = await postPermissionRequest(port, toolName, payload.tool_input);
  if (!decision) return; // fall through: unreachable, timed out, or bad response

  process.stdout.write(JSON.stringify(toHookOutput(decision)));
}

try {
  await main();
} catch {
  // Absolute last resort: something above threw despite every internal guard.
  // Still must never throw uncaught or exit non-zero.
}

process.exit(0);
