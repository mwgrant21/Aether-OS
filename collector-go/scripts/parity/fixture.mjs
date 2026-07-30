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
//   <root>/.claude/settings.json      Claude Code settings (hookinstall CLI)
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
//
// MULTI-TICK CONTENT (appendMidRun below)
// ---------------------------------------
// The harness runs each collector long enough for several 15s transcript-scan
// and fleet-poll ticks (see run-parity.mjs's RUN_MS), and calls appendMidRun()
// partway through each run so the SECOND and later ticks have something new to
// do. That is what gives cross-collector coverage to the behaviors a
// single-tick run can never reach:
//
//   * incremental offset-resume rescan -- transcript_files.last_offset must
//     make each later scan ingest ONLY the newly appended bytes, including
//     resuming from the middle of a previously-incomplete trailing line.
//   * anomaly dedup across ticks -- the detectors re-fire on every tick from
//     the retained in-memory ToolCallHistory, so the unique index on
//     anomalies(kind, tool_use_id) + INSERT OR IGNORE has to collapse the
//     repeats to one row on both sides.
//   * spool files that appear AFTER startup (hooks-c.jsonl).
//
// The fleet side's multi-tick coverage lives in the stub `claude` binary
// instead: FLEET_JSON is returned to the first poll only, FLEET_JSON_LATER to
// every poll after it (see run-parity.mjs's buildStubClaude). The difference
// between the two payloads is what exercises fleet_sessions' ON CONFLICT
// update path (bbb's status changes) and its 30s stale prune (eee disappears
// and must be deleted once its last_seen_ms falls >30s behind).

import { mkdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const ALPHA_CWD = 'C:\\projects\\aether-os';
const BETA_CWD = 'C:\\projects\\token-monitor';

export const OWN_SESSION_ID = 'own-session-aaa';

// The stub `claude agents --json` payload returned to the FIRST poll only.
// Row 1 is the collector's own session (must be filtered out by
// own-session.json), rows 2-3 are real fleet sessions (row 3 has no pid ->
// NULL), row 4 is missing `status` and `startedAt` and must produce exactly
// one drift_log row naming both fields in REQUIRED_STRING_FIELDS order, and
// row 5 is the transient session that vanishes from every later poll.
export const FLEET_JSON = JSON.stringify([
  { sessionId: OWN_SESSION_ID, cwd: ALPHA_CWD, kind: 'main', name: 'Aether', status: 'active', startedAt: 1700000000000, pid: 4242 },
  { sessionId: 'fleet-session-bbb', cwd: BETA_CWD, kind: 'main', name: 'TokenMonitor', status: 'idle', startedAt: 1700000001000, pid: 5150 },
  { sessionId: 'fleet-session-ccc', cwd: 'C:\\projects\\nmm-toolkit', kind: 'subagent', name: 'Toolkit', status: 'active', startedAt: 1700000002000 },
  { sessionId: 'bad-row-ddd', cwd: 'C:\\projects\\x', kind: 'main', name: 'X' },
  { sessionId: 'fleet-session-eee', cwd: 'C:\\projects\\gone', kind: 'subagent', name: 'Transient', status: 'active', startedAt: 1700000003000, pid: 6060 },
]);

// Returned to the second and every later poll. Three deliberate differences
// from FLEET_JSON, each buying coverage a single-poll run cannot have:
//   * bbb's status flips idle -> active: exercises upsertFleetSessions'
//     ON CONFLICT(session_id) DO UPDATE path with a real value change.
//   * bad-row-ddd is gone: so the fleet drift_log row is written on the FIRST
//     poll only, keeping drift_log's row count independent of exactly how
//     many polls fit inside RUN_MS.
//   * fleet-session-eee is gone: its last_seen_ms stops advancing, so once
//     nowMs - last_seen_ms exceeds STALE_MS (30s) the prune must delete it.
//     The final fleet_sessions table therefore proves the prune ran.
export const FLEET_JSON_LATER = JSON.stringify([
  { sessionId: OWN_SESSION_ID, cwd: ALPHA_CWD, kind: 'main', name: 'Aether', status: 'active', startedAt: 1700000000000, pid: 4242 },
  { sessionId: 'fleet-session-bbb', cwd: BETA_CWD, kind: 'main', name: 'TokenMonitor', status: 'active', startedAt: 1700000001000, pid: 5150 },
  { sessionId: 'fleet-session-ccc', cwd: 'C:\\projects\\nmm-toolkit', kind: 'subagent', name: 'Toolkit', status: 'active', startedAt: 1700000002000 },
]);

// The `claude` stub records how many times it has been invoked here, per
// fixture root, so "first poll" is per-collector rather than global. Kept at
// the fixture root (NOT under .aether-os/spool or .claude/projects) so no
// collector loop ever sees it.
export const STUB_CALL_COUNT_FILE = 'stub-claude-calls.txt';

// The schtasks.exe stub appends one JSON argv array per invocation here.
export const STUB_SCHTASKS_LOG_FILE = 'stub-schtasks-calls.jsonl';

function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
}

function iso(baseMs, offsetSec) {
  return new Date(baseMs + offsetSec * 1000).toISOString();
}

// Splits a would-be transcript line into a written head and a withheld tail.
// Slicing a real JSON.stringify result (rather than hand-writing a truncated
// string) guarantees head+tail reassembles into a line that actually parses,
// so the "resume from the middle of an incomplete line" case produces a real
// event instead of a silently-dropped one.
function splitLine(obj, withheldChars) {
  const full = JSON.stringify(obj);
  const cut = full.length - withheldChars;
  return { head: full.slice(0, cut), tail: full.slice(cut) };
}

// The two truncated trailing lines beta's transcript ends with, at fixture
// build time and again after appendMidRun. Derived from baseMs alone so both
// call sites compute byte-identical strings.
function betaTails(baseMs) {
  return {
    // Present (incomplete) from the start; completed by appendMidRun, so the
    // second scan must resume from a last_offset that points at the START of
    // this line, not past it.
    first: splitLine(
      {
        type: 'assistant',
        sessionId: 'beta',
        timestamp: iso(baseMs, -35),
        cwd: BETA_CWD,
        message: {
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [],
        },
      },
      40
    ),
    // Written (incomplete) by appendMidRun and never completed, so the final
    // last_offset must again stop short of a trailing partial line -- the
    // same invariant the single-tick run checked, but now reached via the
    // resume path rather than the first-scan path.
    second: splitLine(
      {
        type: 'assistant',
        sessionId: 'beta',
        timestamp: iso(baseMs, -20),
        cwd: BETA_CWD,
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [],
        },
      },
      55
    ),
  };
}

// The project-relative keys transcript_files stores, and the absolute paths
// behind them. Exported so run-parity.mjs can assert the FINAL last_offset
// values byte-exactly (alpha: whole file; beta: whole file minus the trailing
// partial line appendMidRun leaves behind).
export const ALPHA_REL_PATH = join('C--projects-aether-os', 'session-alpha.jsonl');
export const BETA_REL_PATH = join('C--projects-token-monitor', 'session-beta.jsonl');

export function alphaTranscriptPath(root) {
  return join(root, '.claude', 'projects', ALPHA_REL_PATH);
}

export function betaTranscriptPath(root) {
  return join(root, '.claude', 'projects', BETA_REL_PATH);
}

// Byte length of the incomplete trailing line appendMidRun leaves at the end
// of beta's transcript. The final transcript_files.last_offset for beta must
// be exactly (file size - this), on both collectors.
export function betaTrailingPartialBytes(baseMs) {
  return Buffer.byteLength(betaTails(baseMs).second.head, 'utf8');
}

// A realistic settings.json for the hookinstall/autostart CLI parity pass.
// Modelled on internal/hookinstall/installer_test.go's fixtures: unrelated
// top-level keys that must survive untouched, a pre-existing UNRELATED hook
// group under a managed event (PreToolUse) that our group must be appended
// after rather than replacing, an unrelated group under a NON-managed event
// (SessionStart) that must not be touched at all, and one managed event whose
// value is not an array at all (Stop) -- the "unrecognized shape, skip only
// this event" branch both installers implement.
//
// The command strings deliberately contain <, > and & : Go's
// json.MarshalIndent HTML-escapes those by default and JSON.stringify does
// not. This fixture only EXERCISES that code path -- the actual
// differential check on marshalSettingsJSON's SetEscapeHTML(false) is
// run-parity.mjs's assertNoHtmlEscapes (see runHookInstallParity), which
// reads settings.json's raw bytes and fails if any HTML-escaped sequence
// appears. A structural JSON.parse/JSON.stringify comparison alone (as
// readCanonical does elsewhere in that file) cannot detect this: parsing
// un-escapes HTML entities and re-stringifying never re-escapes them, so an
// escaped and an unescaped settings.json become byte-identical after that
// round-trip.
export function settingsFixture() {
  return {
    model: 'sonnet',
    statusLine: { type: 'command', command: 'node "C:\\tools\\statusline.mjs"' },
    permissions: { allow: ['Bash(git status:*)', 'Read(//c/**)'], deny: ['Bash(rm -rf:*)'] },
    env: { AETHER_PARITY_FIXTURE: '1' },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:\\tools\\other-hook.mjs" 2>&1 && echo ok' }] },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'echo <start> & echo "a > b"' }] },
      ],
      // Not an array: both installers must leave this key exactly as-is and
      // skip only this event, without failing the whole install.
      Stop: 'unrecognized-shape-left-alone',
    },
  };
}

export function buildFixture(root, baseMs) {
  const aetherDir = join(root, '.aether-os');
  const spoolDir = join(aetherDir, 'spool');
  const claudeDir = join(root, '.claude');
  const projectsRoot = join(claudeDir, 'projects');
  const alphaDir = join(projectsRoot, 'C--projects-aether-os');
  const betaDir = join(projectsRoot, 'C--projects-token-monitor');
  const emptyDir = join(projectsRoot, 'C--projects-empty');

  for (const d of [spoolDir, alphaDir, betaDir, emptyDir]) mkdirSync(d, { recursive: true });

  writeFileSync(join(aetherDir, 'own-session.json'), JSON.stringify({ sessionId: OWN_SESSION_ID }), 'utf8');

  // ---- settings.json (hookinstall / autostart CLI parity) -----------------
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settingsFixture(), null, 2), 'utf8');

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
  writeFileSync(alphaTranscriptPath(root), jsonl(alphaLines), 'utf8');

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
  writeFileSync(betaTranscriptPath(root), jsonl(betaLines) + betaTails(baseMs).first.head, 'utf8');

  // A non-.jsonl file in a project dir (must be ignored) and an empty project
  // directory (must be walked without error).
  writeFileSync(join(betaDir, 'notes.txt'), 'ignore me\n', 'utf8');

  return {
    aetherDir,
    spoolDir,
    claudeDir,
    projectsRoot,
    dbPath: join(aetherDir, 'collector.db'),
    settingsPath: join(claudeDir, 'settings.json'),
    stubCallCountPath: join(root, STUB_CALL_COUNT_FILE),
    stubSchtasksLogPath: join(root, STUB_SCHTASKS_LOG_FILE),
  };
}

// Called partway through each collector's run (see run-parity.mjs's
// APPEND_AT_MS) so the second and later transcript-scan ticks have new bytes
// to resume into. Must be byte-deterministic from (root, baseMs) alone, since
// each collector gets its own root but the same baseMs.
export function appendMidRun(root, baseMs) {
  const alphaFile = 'C:\\projects\\aether-os\\src\\index.ts';
  const tails = betaTails(baseMs);

  // alpha: a FOURTH read of the already-thrice-read path. The reReadLoop
  // detector's tool_use_id is the most recently closed read, so this produces
  // a genuinely NEW (kind, tool_use_id) anomaly row alongside the one already
  // stored -- proving the unique index dedups repeats without over-collapsing
  // distinct detections.
  appendFileSync(
    alphaTranscriptPath(root),
    jsonl([
      {
        type: 'assistant',
        sessionId: 'alpha',
        timestamp: iso(baseMs, -30),
        cwd: ALPHA_CWD,
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 2000, output_tokens: 11, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000 },
          content: [{ type: 'tool_use', id: 'tu-read-4', name: 'Read', input: { file_path: alphaFile } }],
        },
      },
      {
        type: 'user',
        sessionId: 'alpha',
        timestamp: iso(baseMs, -29),
        cwd: ALPHA_CWD,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-read-4', content: 'read again' }] },
      },
    ]),
    'utf8'
  );

  // beta: complete the trailing partial line left by buildFixture, add one
  // more complete line, then leave a NEW trailing partial. The resume must
  // start at the byte offset of the incomplete line's first character.
  appendFileSync(
    betaTranscriptPath(root),
    tails.first.tail +
      '\n' +
      jsonl([
        {
          type: 'assistant',
          sessionId: 'beta',
          timestamp: iso(baseMs, -25),
          cwd: BETA_CWD,
          message: { model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tu-write-4', name: 'Edit', input: { file_path: 'C:\\projects\\token-monitor\\src\\App.tsx' } }] },
        },
        {
          type: 'user',
          sessionId: 'beta',
          timestamp: iso(baseMs, -24),
          cwd: BETA_CWD,
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu-write-4', content: { ok: true } }] },
        },
      ]) +
      tails.second.head,
    'utf8'
  );

  // A spool file that appears only AFTER the collector has already started:
  // written under a non-.jsonl name and renamed into place so no tail tick can
  // ever observe a half-written file.
  const spoolDir = join(root, '.aether-os', 'spool');
  const tmp = join(spoolDir, 'hooks-c.jsonl.partial');
  writeFileSync(
    tmp,
    jsonl([
      { hook_event_name: 'PreToolUse', session_id: 'gamma', cwd: ALPHA_CWD, tool_name: 'Edit', tool_input: { file_path: 'src/state/tick.ts' } },
      { hook_event_name: 'Stop', session_id: 'gamma', cwd: ALPHA_CWD },
    ]),
    'utf8'
  );
  renameSync(tmp, join(spoolDir, 'hooks-c.jsonl'));
}
