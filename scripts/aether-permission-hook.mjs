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
//   Also installed as the `command` for the PostToolUse and Notification hooks,
//   branching on stdin's `hook_event_name` field:
//   PermissionRequest --
//     stdin:  { session_id, permission_mode, tool_name, tool_input, tool_use_id }
//     stdout (exit 0): { hookSpecificOutput: { hookEventName: "PermissionRequest",
//                         decision: { behavior: "allow" | "deny", updatedInput? } } }
//   PostToolUse --
//     stdin:  { session_id, tool_name, tool_input, tool_output, tool_use_id,
//               hook_event_name: "PostToolUse" }
//     stdout (exit 0, only when blocking): { "decision": "block", "reason"? }
//     -- a BARE string field, NOT the nested hookSpecificOutput.decision.behavior
//     shape PermissionRequest uses above. A clean result (block: false) means
//     no stdout at all, same fall-through discipline as everything else here.
//   Notification --
//     stdin:  { session_id, notification_type, hook_event_name: "Notification" }
//     -- no `tool_name`, unlike the other two events.
//     stdout: never. Fire-and-forget ack to the permission server's
//     /notification route -- no decision contract to honor either way.
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

// Resolves with the parsed flag-check decision ({ block, reason? }), or null
// if the server was unreachable, timed out, or returned something unusable.
// Never rejects. Mirrors postPermissionRequest's connect/overall timeout
// discipline but targets the separate /post-tool-flag-check route, which
// speaks a different request/response shape (see
// electron/permissionServer.ts's PostToolFlagDecision).
function postToolFlagCheck(port, toolUseId, toolName, toolOutput) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = JSON.stringify({ toolUseId, toolName, toolOutput });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/post-tool-flag-check',
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
            if (parsed && typeof parsed === 'object' && typeof parsed.block === 'boolean') {
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

    // Same fail-fast-on-connect discipline as postPermissionRequest above --
    // "is the app even reachable" for this endpoint too.
    const connectTimer = setTimeout(() => {
      req.destroy();
      done(null);
    }, CONNECT_TIMEOUT_MS);
    req.once('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });

    const overallTimer = setTimeout(() => {
      req.destroy();
      done(null);
    }, DECISION_TIMEOUT_MS);
    overallTimer.unref?.();

    req.end(body);
  });
}

// Fire-and-forget: no decision to wait for, so this only needs the short
// connect-timeout discipline (is the app even reachable), not the full
// DECISION_TIMEOUT_MS wait the other two routes need.
function postNotification(port, sessionId, notificationType) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const body = JSON.stringify({ sessionId, notificationType });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/notification',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', done);
        res.on('error', done);
      }
    );
    req.on('error', done);
    const connectTimer = setTimeout(() => {
      req.destroy();
      done();
    }, CONNECT_TIMEOUT_MS);
    req.once('socket', (socket) => {
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.end(body);
  });
}

// Translates a /post-tool-flag-check decision into the REAL PostToolUse hook
// stdout contract: a bare "decision": "block" string field (design spec,
// "Verified real infrastructure" -- NOT the nested
// hookSpecificOutput.decision.behavior object shape PermissionRequest uses).
// Returns null when the decision is clean (block: false) -- no stdout means
// "let this turn stand," same as PermissionRequest's fall-through discipline.
function toPostToolUseOutput(decision) {
  if (!decision.block) return null;
  const out = { decision: 'block' };
  if (decision.reason !== undefined) out.reason = decision.reason;
  return out;
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
  if (!sessionId) return; // fall through: unusable payload

  const aetherDir = join(homedir(), '.aether-os');
  const ownSessionId = readOwnSessionId(join(aetherDir, 'own-session.json'));
  if (!ownSessionId || ownSessionId !== sessionId) return; // fall through: not our session

  const port = readPort(join(aetherDir, 'permission-server-port'));
  if (!port) return; // fall through: app not running / no port file

  if (payload.hook_event_name === 'Notification') {
    const notificationType = typeof payload.notification_type === 'string' ? payload.notification_type : null;
    if (!notificationType) return; // fall through: unusable payload
    await postNotification(port, sessionId, notificationType);
    return; // no stdout: Notification has no decision contract to honor
  }

  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  if (!toolName) return; // fall through: unusable payload

  if (payload.hook_event_name === 'PostToolUse') {
    const toolUseId = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null;
    if (!toolUseId) return; // fall through: unusable payload
    const flagDecision = await postToolFlagCheck(port, toolUseId, toolName, payload.tool_output);
    if (!flagDecision) return; // fall through: unreachable, timed out, or bad response
    const out = toPostToolUseOutput(flagDecision);
    if (out) process.stdout.write(JSON.stringify(out));
    return;
  }

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
