// Fixture generator for the golden-file parity harness (see run-parity.mjs).
//
// Builds a self-contained fake HOME directory that both collectors can be
// pointed at (Node's os.homedir() and Go's os.UserHomeDir() both read
// %USERPROFILE% on Windows, so a single env override drives both binaries
// through their real, unmodified path-resolution code):
//
//   <root>/.aether-os/spool/*.jsonl   hook-event spool lines (spool ingest)
//   <root>/.aether-os/own-session.json  own-session id (fleet self-filter)
//   <root>/.claude/projects/<dir>/*.jsonl  transcript sessions (transcript scan)
//
// Every timestamp that feeds a windowed detector is generated relative to the
// moment the fixture is built, because anomalyIngest's detectors only consider
// tool calls closed within the last 5 minutes of wall-clock time. Both
// collectors are run immediately after generation, so both see the same window.
//
// Content is deliberately chosen to exercise, in one pass: valid + malformed +
// unknown hook events, the drift canary on both of its trigger paths, usage
// ingest, tool-call open/close correlation, absolute->project-relative path
// sanitization, the reReadLoop and writeDeleteRewrite detectors, subagent
// dispatch completion, a blank line, an unparseable line, and a trailing
// partial line with no newline (byte-offset handling).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ALPHA_CWD = 'C:\\projects\\aether-os';
const BETA_CWD = 'C:\\projects\\token-monitor';

export const OWN_SESSION_ID = 'own-session-aaa';

// The stub `claude agents --json` payload. Row 1 is the collector's own
// session (must be filtered out by own-session.json), rows 2-3 are real fleet
// sessions (row 3 has no pid -> NULL), row 4 is missing `status` and
// `startedAt` and must produce exactly one drift_log row naming both fields in
// REQUIRED_STRING_FIELDS order.
export const FLEET_JSON = JSON.stringify([
  { sessionId: OWN_SESSION_ID, cwd: ALPHA_CWD, kind: 'main', name: 'Aether', status: 'active', startedAt: 1700000000000, pid: 4242 },
  { sessionId: 'fleet-session-bbb', cwd: BETA_CWD, kind: 'main', name: 'TokenMonitor', status: 'idle', startedAt: 1700000001000, pid: 5150 },
  { sessionId: 'fleet-session-ccc', cwd: 'C:\\projects\\nmm-toolkit', kind: 'subagent', name: 'Toolkit', status: 'active', startedAt: 1700000002000 },
  { sessionId: 'bad-row-ddd', cwd: 'C:\\projects\\x', kind: 'main', name: 'X' },
]);

function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
}

function iso(baseMs, offsetSec) {
  return new Date(baseMs + offsetSec * 1000).toISOString();
}

export function buildFixture(root, baseMs) {
  const aetherDir = join(root, '.aether-os');
  const spoolDir = join(aetherDir, 'spool');
  const projectsRoot = join(root, '.claude', 'projects');
  const alphaDir = join(projectsRoot, 'C--projects-aether-os');
  const betaDir = join(projectsRoot, 'C--projects-token-monitor');
  const emptyDir = join(projectsRoot, 'C--projects-empty');

  for (const d of [spoolDir, alphaDir, betaDir, emptyDir]) mkdirSync(d, { recursive: true });

  writeFileSync(join(aetherDir, 'own-session.json'), JSON.stringify({ sessionId: OWN_SESSION_ID }), 'utf8');

  // ---- spool: hook events -------------------------------------------------
  writeFileSync(
    join(spoolDir, 'hooks-a.jsonl'),
    jsonl([
      { hook_event_name: 'PreToolUse', session_id: 'alpha', cwd: ALPHA_CWD, tool_name: 'Read', tool_input: { file_path: 'src/index.ts' } },
      { hook_event_name: 'PostToolUse', session_id: 'alpha', cwd: ALPHA_CWD, tool_name: 'Read', tool_input: { file_path: 'src/index.ts' }, tool_response: { ok: true } },
      { hook_event_name: 'Notification', session_id: 'alpha', cwd: ALPHA_CWD, notification_type: 'permission_request' },
      { hook_event_name: 'Stop', session_id: 'alpha', cwd: ALPHA_CWD },
    ]),
    'utf8'
  );

  writeFileSync(
    join(spoolDir, 'hooks-b.jsonl'),
    jsonl([
      // drift: known event, required field absent -> drift_log row + skipped
      { hook_event_name: 'PostToolUse', session_id: 'beta', cwd: BETA_CWD },
      // unknown event name -> silently skipped, NOT drift
      { hook_event_name: 'SessionStart', session_id: 'beta', cwd: BETA_CWD },
      // no cwd -> project_rel_path NULL; empty tool_input object still counts as present
      { hook_event_name: 'PreToolUse', session_id: 'beta', tool_name: 'Bash', tool_input: {} },
      'not-json-at-all',
      // drift: Notification without notification_type
      { hook_event_name: 'Notification', session_id: 'beta', cwd: BETA_CWD },
      // empty session_id -> parseHookPayload returns null, no drift (Stop requires nothing)
      { hook_event_name: 'Stop', session_id: '', cwd: BETA_CWD },
      // Known event, missing required field AND unparseable (no session_id).
      // canary.ts's checkForDrift runs on the RAW payload BEFORE
      // parseHookPayload, so the TS collector logs drift here even though the
      // line is then skipped as unparseable.
      { hook_event_name: 'PostToolUse', cwd: BETA_CWD },
      // Same class, via an empty-string session_id and an explicitly null
      // required field.
      { hook_event_name: 'Notification', session_id: '', cwd: BETA_CWD, notification_type: null },
      // Empty-string tool_name: PRESENT for the raw canary (not drift) but
      // absent for hookPayload.ts's stringField -> inserted with NULL tool_name.
      { hook_event_name: 'PreToolUse', session_id: 'beta', cwd: BETA_CWD, tool_name: '' },
      '',
      '   ',
    ]),
    'utf8'
  );

  // ---- transcripts --------------------------------------------------------
  // alpha: three Reads of one absolute path (reReadLoop), one Agent dispatch
  // that completes via a task-notification, two usage-bearing assistant turns.
  const alphaFile = 'C:\\projects\\aether-os\\src\\index.ts';
  const alphaLines = [];
  for (const [i, id] of ['tu-read-1', 'tu-read-2', 'tu-read-3'].entries()) {
    alphaLines.push({
      type: 'assistant',
      sessionId: 'alpha',
      timestamp: iso(baseMs, -120 + i * 10),
      cwd: ALPHA_CWD,
      message: {
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 1200 + i, output_tokens: 340, cache_creation_input_tokens: 900, cache_read_input_tokens: 15000 },
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: alphaFile } }],
      },
    });
    alphaLines.push({
      type: 'user',
      sessionId: 'alpha',
      timestamp: iso(baseMs, -118 + i * 10),
      cwd: ALPHA_CWD,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'file contents elided' }] },
    });
  }
  alphaLines.push({
    type: 'assistant',
    sessionId: 'alpha',
    timestamp: iso(baseMs, -90),
    cwd: ALPHA_CWD,
    message: {
      model: 'claude-opus-4-1',
      usage: { input_tokens: 55, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu-agent-1', name: 'Agent', input: { description: 'explore' } }],
    },
  });
  alphaLines.push({
    type: 'user',
    sessionId: 'alpha',
    timestamp: iso(baseMs, -80),
    cwd: ALPHA_CWD,
    origin: { kind: 'task-notification' },
    message: {
      content:
        'Agent finished <tool-use-id>tu-agent-1</tool-use-id> <subagent_tokens>48210</subagent_tokens> <tool_uses>7</tool_uses> <duration_ms>91234</duration_ms>',
    },
  });
  // An absolute path on a different drive: toProjectRelative must NULL it.
  alphaLines.push({
    type: 'assistant',
    sessionId: 'alpha',
    timestamp: iso(baseMs, -75),
    cwd: ALPHA_CWD,
    message: { model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tu-otherdrive', name: 'Read', input: { file_path: 'D:\\elsewhere\\notes.md' } }] },
  });
  alphaLines.push({
    type: 'user',
    sessionId: 'alpha',
    timestamp: iso(baseMs, -74),
    cwd: ALPHA_CWD,
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu-otherdrive', content: 'x' }] },
  });
  alphaLines.push('{ this is not valid json');
  alphaLines.push({ type: 'summary', summary: 'session summary', leafUuid: 'abc' });
  alphaLines.push('');
  writeFileSync(join(alphaDir, 'session-alpha.jsonl'), jsonl(alphaLines), 'utf8');

  // beta: three Writes of one file (writeDeleteRewrite), a usage-only turn,
  // and a trailing partial line with NO newline (must not be consumed, and
  // must leave last_offset pointing just past the last complete line).
  const betaFile = 'C:\\projects\\token-monitor\\src\\App.tsx';
  const betaLines = [];
  for (const [i, id] of ['tu-write-1', 'tu-write-2', 'tu-write-3'].entries()) {
    betaLines.push({
      type: 'assistant',
      sessionId: 'beta',
      timestamp: iso(baseMs, -60 + i * 5),
      cwd: BETA_CWD,
      message: { model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: betaFile } }] },
    });
    betaLines.push({
      type: 'user',
      sessionId: 'beta',
      timestamp: iso(baseMs, -59 + i * 5),
      cwd: BETA_CWD,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: { ok: true } }] },
    });
  }
  betaLines.push({
    type: 'assistant',
    sessionId: 'beta',
    timestamp: iso(baseMs, -40),
    cwd: BETA_CWD,
    message: { model: 'claude-haiku-4-5', usage: { input_tokens: 9, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 }, content: [] },
  });
  writeFileSync(
    join(betaDir, 'session-beta.jsonl'),
    jsonl(betaLines) + '{"type":"assistant","sessionId":"beta","message":{"usa',
    'utf8'
  );

  // A non-.jsonl file in a project dir (must be ignored) and an empty project
  // directory (must be walked without error).
  writeFileSync(join(betaDir, 'notes.txt'), 'ignore me\n', 'utf8');

  return { aetherDir, spoolDir, projectsRoot, dbPath: join(aetherDir, 'collector.db') };
}
