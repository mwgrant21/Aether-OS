#!/usr/bin/env node
// aether-board: agent-facing CLI for the Aether terminal board (privacy section 19).
//
// Each Aether terminal (alpha / beta) owns one small JSON file under
// ~/.aether-os/terminal-board/. This CLI reads both and writes ONLY the caller's own file,
// chosen from AETHER_TERMINAL (exactly "alpha" or "beta"; anything else = no identity, and
// every write verb refuses with exit 2 and no filesystem effect). Advisory only.
//
// Self-contained on purpose: it runs from any cwd and from resources/scripts when packaged,
// so it cannot import the TypeScript modules. Everything below marked "PARITY" is a hand
// copy; scripts/aether-board.parity.test.ts pins it against the real modules.
//
// Exit codes: 0 ok, 1 usage / validation / not found, 2 no identity, 3 claim conflict,
// 4 write failed. Output goes through process.exitCode, never process.exit() after output.

import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

// ---------------------------------------------------------------------------------------
// PARITY: constants. Source of truth: src/shared/terminalBoard.ts
// ---------------------------------------------------------------------------------------
const SCHEMA_VERSION = 1;
const TERMINAL_BOARD_STALE_MS = 4 * 60 * 60 * 1000;
const DIR_NAME = 'terminal-board';
const TERMINALS = ['alpha', 'beta'];
const STATUSES = ['working', 'idle', 'blocked', 'waiting-on-user'];
const CLAIM_KINDS = ['pr', 'branch', 'worktree', 'file'];
const LIMITS = { title: 120, project: 80, ref: 200, note: 200, claims: 50, blockedBy: 50 };

// ---------------------------------------------------------------------------------------
// PARITY: validator. Source of truth: parseBoardEntry and helpers in src/shared/terminalBoard.ts
// ---------------------------------------------------------------------------------------
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_REF = /^(?:[A-Za-z]:|[\\/]|~)/;
const FILE_URL_REF = /^file:/i;

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isDateString(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}
function isText(v, max, allowEmpty) {
  if (typeof v !== 'string') return false;
  if (v.length > max || CONTROL_CHARS.test(v)) return false;
  return allowEmpty || v.trim().length > 0;
}
function hasParentSegment(s) {
  return s.split(/[\\/]/).some((seg) => seg.trim() === '..');
}
function isRef(v) {
  if (!isText(v, LIMITS.ref, false)) return false;
  const s = v.trimStart();
  return !ABSOLUTE_REF.test(s) && !FILE_URL_REF.test(s) && !hasParentSegment(s);
}
function oneOf(list, v) {
  return typeof v === 'string' && list.includes(v);
}

function parseBoardEntry(raw, expected) {
  try {
    if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
    if (raw.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'schema-version' };
    if (raw.terminal !== expected) return { ok: false, reason: 'terminal-mismatch' };
    if (!isDateString(raw.updatedAt)) return { ok: false, reason: 'updated-at' };

    let task = null;
    if (raw.task !== null) {
      const t = raw.task;
      if (
        !isRecord(t) ||
        !isText(t.title, LIMITS.title, false) ||
        !isText(t.project, LIMITS.project, true) ||
        !oneOf(STATUSES, t.status)
      ) {
        return { ok: false, reason: 'task' };
      }
      task = { title: t.title, project: t.project, status: t.status };
    }

    if (!Array.isArray(raw.claims)) return { ok: false, reason: 'claim' };
    if (raw.claims.length > LIMITS.claims) return { ok: false, reason: 'too-many-claims' };
    const claims = [];
    for (const c of raw.claims) {
      if (
        !isRecord(c) ||
        !oneOf(CLAIM_KINDS, c.kind) ||
        !isRef(c.ref) ||
        !isDateString(c.since) ||
        CONTROL_CHARS.test(c.since) ||
        (c.note !== undefined && !isText(c.note, LIMITS.note, true))
      ) {
        return { ok: false, reason: 'claim' };
      }
      const claim = { kind: c.kind, ref: c.ref, since: c.since };
      if (c.note !== undefined) claim.note = c.note;
      claims.push(claim);
    }

    if (!Array.isArray(raw.blockedBy)) return { ok: false, reason: 'blocked-by' };
    if (raw.blockedBy.length > LIMITS.blockedBy) return { ok: false, reason: 'blocked-by' };
    const blockedBy = [];
    for (const b of raw.blockedBy) {
      if (!isRecord(b) || !isRef(b.ref) || !oneOf(TERMINALS, b.owner)) {
        return { ok: false, reason: 'blocked-by' };
      }
      blockedBy.push({ ref: b.ref, owner: b.owner });
    }

    return {
      ok: true,
      entry: { schemaVersion: 1, terminal: expected, updatedAt: raw.updatedAt, task, claims, blockedBy },
    };
  } catch {
    return { ok: false, reason: 'not-object' };
  }
}

// PARITY: isBoardEntryStale. Strictly greater than the window is stale; a future updatedAt is not.
function isStale(entry, nowMs) {
  const t = Date.parse(entry.updatedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > TERMINAL_BOARD_STALE_MS;
}

// PARITY: classifyBoardText.
function classify(terminal, text, nowMs) {
  if (text === null) return { terminal, source: 'missing', entry: null, stale: false };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { terminal, source: 'invalid', entry: null, stale: false, reason: 'bad-json' };
  }
  const parsed = parseBoardEntry(raw, terminal);
  if (!parsed.ok) return { terminal, source: 'invalid', entry: null, stale: false, reason: parsed.reason };
  return { terminal, source: 'file', entry: parsed.entry, stale: isStale(parsed.entry, nowMs) };
}

// PARITY: emptyBoardEntry.
function emptyEntry(terminal, nowMs) {
  return {
    schemaVersion: 1,
    terminal,
    updatedAt: new Date(nowMs).toISOString(),
    task: null,
    claims: [],
    blockedBy: [],
  };
}

// ---------------------------------------------------------------------------------------
// PARITY: atomic writer. Source of truth: uniqueSiblingPath / resolveRealPath /
// writeFileAtomically in electron/atomicWrite.ts (same aethertmp marker, same rules:
// follow symlinks incl. dangling, keep mode bits, refuse a read-only target with EACCES,
// write a hard-linked target in place, otherwise tmp sibling + chmod + rename, and remove
// the tmp on any failure except a lost exclusive create).
// ---------------------------------------------------------------------------------------
function uniqueSiblingPath(targetPath, marker) {
  return `${targetPath}.${marker}-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function resolveRealPath(targetPath, depth = 0) {
  try {
    return realpathSync(targetPath);
  } catch {
    if (depth < 32) {
      try {
        if (lstatSync(targetPath).isSymbolicLink()) {
          const link = readlinkSync(targetPath);
          const next = isAbsolute(link) ? link : resolve(dirname(targetPath), link);
          return resolveRealPath(next, depth + 1);
        }
      } catch {
        // Not a link, or unreadable: fall through to the path itself.
      }
    }
    return targetPath;
  }
}

function writeFileAtomically(targetPath, content) {
  const realPath = resolveRealPath(targetPath);

  let mode;
  let hardLinked = false;
  try {
    const st = statSync(realPath);
    mode = st.mode & 0o777;
    hardLinked = st.nlink > 1;
  } catch {
    mode = undefined;
  }

  if (mode !== undefined) {
    try {
      accessSync(realPath, constants.W_OK);
    } catch {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
  }

  if (hardLinked) {
    writeFileSync(realPath, content, { encoding: 'utf8' });
    return;
  }

  const tmpPath = uniqueSiblingPath(realPath, 'aethertmp');
  try {
    writeFileSync(tmpPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      ...(mode !== undefined ? { mode } : {}),
    });
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best effort
      }
    }
    throw err;
  }

  try {
    if (mode !== undefined) chmodSync(tmpPath, mode);
    renameSync(tmpPath, realPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

const USAGE = `usage: aether-board <verb> [args]

  whoami                              print this terminal's name (alpha or beta)
  status [--json]                     show both terminals' boards (read-only)
  task "<title>" [--project P] [--status S]
                                      set what this terminal is working on
                                      (S: ${STATUSES.join(' | ')}; default working)
  claim <kind> <ref> [--note N]       claim a ${CLAIM_KINDS.join(' | ')} (exit 3 if the other terminal holds it)
  release <ref>                       drop my claim / blocked entry for <ref>
  blocked <ref>                       record that the other terminal holds <ref>
  clear                               empty this terminal's board entry
  help                                this text

Writes only this terminal's own file (chosen from AETHER_TERMINAL=alpha|beta).
Exit codes: 0 ok, 1 usage/validation, 2 no identity, 3 conflict, 4 write failed.
`;

// flag name -> 'value' (takes an argument) | 'bool'
const VERB_FLAGS = {
  whoami: {},
  status: { json: 'bool' },
  task: { project: 'value', status: 'value' },
  claim: { note: 'value' },
  release: {},
  blocked: {},
  clear: {},
};
const WRITE_VERBS = new Set(['task', 'claim', 'release', 'blocked', 'clear']);

function parseArgs(verb, args) {
  const spec = VERB_FLAGS[verb];
  const flags = {};
  const positionals = [];
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest || !a.startsWith('--') || a === '--') {
      if (!rest && a === '--') {
        rest = true;
        continue;
      }
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const kind = Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new CliError(1, `unknown flag --${name}\n${USAGE}`);
    if (kind === 'bool') {
      if (eq !== -1) throw new CliError(1, `--${name} takes no value`);
      flags[name] = true;
    } else if (eq !== -1) {
      flags[name] = a.slice(eq + 1);
    } else {
      if (i + 1 >= args.length) throw new CliError(1, `--${name} needs a value`);
      flags[name] = args[++i];
    }
  }
  return { flags, positionals };
}

function identity() {
  const v = process.env.AETHER_TERMINAL;
  return v === 'alpha' || v === 'beta' ? v : null;
}
const NO_IDENTITY =
  'aether-board: AETHER_TERMINAL is not set to alpha or beta; this shell is not an Aether terminal. Nothing written.';

function boardDir() {
  return join(homedir(), '.aether-os', DIR_NAME);
}
// The file path comes only from the closed TERMINALS list, never from the environment.
function boardFile(terminal) {
  if (!TERMINALS.includes(terminal)) throw new CliError(1, 'internal: bad terminal');
  return join(boardDir(), `${terminal}.json`);
}

/** Reads and classifies one terminal's file. Unreadable (not just absent) is invalid/unreadable. */
function readView(terminal, nowMs) {
  let text;
  try {
    text = readFileSync(boardFile(terminal), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return classify(terminal, null, nowMs);
    return { terminal, source: 'invalid', entry: null, stale: false, reason: 'unreadable' };
  }
  return classify(terminal, text, nowMs);
}

/** Own file as a base for read-modify-write: a bad file is replaced from empty, with a warning. */
function loadOwn(me, nowMs) {
  const view = readView(me, nowMs);
  if (view.source === 'file') return view.entry;
  if (view.source === 'invalid') {
    process.stderr.write(`aether-board: existing board file was invalid (${view.reason}); starting from empty\n`);
  }
  return emptyEntry(me, nowMs);
}

function persist(me, entry, nowMs) {
  entry.updatedAt = new Date(nowMs).toISOString();
  const check = parseBoardEntry(JSON.parse(JSON.stringify(entry)), me);
  if (!check.ok) throw new CliError(1, `aether-board: refusing to write an invalid entry (${check.reason})`);
  const text = JSON.stringify(check.entry, null, 2) + '\n';
  try {
    mkdirSync(boardDir(), { recursive: true, mode: 0o700 });
    writeFileAtomically(boardFile(me), text);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'UNKNOWN';
    throw new CliError(4, `aether-board: write failed (${code})`);
  }
}

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function viewLines(view, me, nowMs) {
  const tag = view.terminal === me ? `${view.terminal} (you)` : view.terminal;
  if (view.source === 'missing') return [`${tag}: no board file`];
  if (view.source === 'invalid') return [`${tag}: invalid file (${view.reason})`];
  const e = view.entry;
  const age = ago(nowMs - Date.parse(e.updatedAt));
  const when = view.stale ? `stale (${age})` : `updated ${age}`;
  const what = e.task
    ? `${e.task.status} "${e.task.title}"${e.task.project ? ` [${e.task.project}]` : ''}`
    : 'no task';
  const lines = [`${tag}: ${what}, ${when}`];
  for (const c of e.claims) lines.push(`  ${c.kind} ${c.ref} since ${c.since}${c.note ? ` - ${c.note}` : ''}`);
  for (const b of e.blockedBy) lines.push(`  blocked by ${b.owner} on ${b.ref}`);
  return lines;
}

function cmdStatus(flags) {
  const nowMs = Date.now();
  const views = { alpha: readView('alpha', nowMs), beta: readView('beta', nowMs) };
  if (flags.json) {
    const out = { at: new Date(nowMs).toISOString(), staleAfterMs: TERMINAL_BOARD_STALE_MS, terminals: views };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const me = identity();
  const lines = [...viewLines(views.alpha, me, nowMs), ...viewLines(views.beta, me, nowMs)];
  process.stdout.write(lines.join('\n') + '\n');
}

function cmdClear(me) {
  const nowMs = Date.now();
  loadOwn(me, nowMs); // surfaces the invalid-file warning; the result is replaced anyway
  persist(me, emptyEntry(me, nowMs), nowMs);
}

// Comparison key only; the STORED ref is exactly as given. "155", "#155" and "PR 155" collide.
function refKey(ref) {
  const s = ref.toLowerCase().replace(/\\/g, '/');
  const m = /^(?:pr\s*)?#?(\d+)$/i.exec(s);
  return m ? `#${m[1]}` : s;
}

const OTHER = { alpha: 'beta', beta: 'alpha' };

/** Runs the assembled entry through the carried validator before anything is written. */
function assertValid(me, entry) {
  const check = parseBoardEntry(JSON.parse(JSON.stringify(entry)), me);
  if (!check.ok) {
    throw new CliError(
      1,
      `aether-board: invalid input (${check.reason}); check length limits, control characters, and that refs are relative with no ".." segment. Nothing written.`,
    );
  }
}

function cmdTask(me, flags, positionals) {
  if (positionals.length === 0) throw new CliError(1, 'aether-board: task needs a title\n' + USAGE);
  if (positionals.length > 1) throw new CliError(1, 'aether-board: task takes exactly one title; quote the title');
  const status = flags.status === undefined ? 'working' : flags.status;
  if (!STATUSES.includes(status)) {
    throw new CliError(1, `aether-board: --status must be one of ${STATUSES.join(', ')}`);
  }
  const nowMs = Date.now();
  const entry = loadOwn(me, nowMs);
  entry.task = { title: positionals[0], project: flags.project === undefined ? '' : flags.project, status };
  assertValid(me, entry);
  persist(me, entry, nowMs);
  process.stdout.write(`task set: ${status} "${positionals[0]}"\n`);
}

function cmdClaim(me, flags, positionals) {
  if (positionals.length !== 2) throw new CliError(1, 'aether-board: usage: claim <kind> <ref> [--note N]');
  const [kind, ref] = positionals;
  if (!CLAIM_KINDS.includes(kind)) {
    throw new CliError(1, `aether-board: claim kind must be one of ${CLAIM_KINDS.join(', ')}`);
  }
  const nowMs = Date.now();
  const key = refKey(ref);
  const entry = loadOwn(me, nowMs);
  const mine = entry.claims.find((c) => refKey(c.ref) === key);
  if (mine) {
    if (flags.note !== undefined) mine.note = flags.note;
  } else {
    const claim = { kind, ref, since: new Date(nowMs).toISOString() };
    if (flags.note !== undefined) claim.note = flags.note;
    entry.claims.push(claim);
  }
  assertValid(me, entry);

  const other = OTHER[me];
  const view = readView(other, nowMs);
  const theirs = view.source === 'file' ? view.entry.claims.find((c) => refKey(c.ref) === key) : undefined;
  let notice = '';
  if (theirs && !view.stale) {
    const note = theirs.note ? `, "${theirs.note}"` : '';
    throw new CliError(
      3,
      `CONFLICT: ${theirs.ref} is claimed by ${other} (${theirs.kind}, since ${theirs.since}${note}). Do not edit it and do not wait. Run: aether-board blocked ${ref} and continue with other work.`,
    );
  }
  if (theirs && view.stale) notice = `note: ${other}'s board is stale; its claim on ${theirs.ref} was ignored\n`;
  persist(me, entry, nowMs);
  process.stdout.write(notice + `claimed ${kind} ${ref}\n`);
}

function cmdRelease(me, positionals) {
  if (positionals.length !== 1) throw new CliError(1, 'aether-board: usage: release <ref>');
  const nowMs = Date.now();
  const key = refKey(positionals[0]);
  const entry = loadOwn(me, nowMs);
  const claims = entry.claims.filter((c) => refKey(c.ref) !== key);
  const blockedBy = entry.blockedBy.filter((b) => refKey(b.ref) !== key);
  if (claims.length === entry.claims.length && blockedBy.length === entry.blockedBy.length) {
    process.stdout.write('nothing to release\n');
    return;
  }
  entry.claims = claims;
  entry.blockedBy = blockedBy;
  persist(me, entry, nowMs);
  process.stdout.write(`released ${positionals[0]}\n`);
}

function cmdBlocked(me, positionals) {
  if (positionals.length !== 1) throw new CliError(1, 'aether-board: usage: blocked <ref>');
  const nowMs = Date.now();
  const key = refKey(positionals[0]);
  const other = OTHER[me];
  const view = readView(other, nowMs);
  const theirs = view.source === 'file' && !view.stale ? view.entry.claims.find((c) => refKey(c.ref) === key) : undefined;
  if (!theirs) throw new CliError(1, `aether-board: no active claim on ${positionals[0]} by ${other}; nothing recorded`);
  const entry = loadOwn(me, nowMs);
  entry.blockedBy = entry.blockedBy.filter((b) => !(b.owner === other && refKey(b.ref) === key));
  entry.blockedBy.push({ ref: theirs.ref, owner: other });
  assertValid(me, entry);
  persist(me, entry, nowMs);
  process.stdout.write(`blocked by ${other} on ${theirs.ref}\n`);
}

function run(argv) {
  const verb = argv[0];
  if (verb === undefined) throw new CliError(1, USAGE);
  if (verb === 'help' || verb === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(VERB_FLAGS, verb)) {
    throw new CliError(1, `unknown verb "${verb}"\n${USAGE}`);
  }
  const { flags, positionals } = parseArgs(verb, argv.slice(1));

  const me = identity();
  if ((WRITE_VERBS.has(verb) || verb === 'whoami') && me === null) throw new CliError(2, NO_IDENTITY);

  switch (verb) {
    case 'whoami':
      process.stdout.write(`${me}\n`);
      return;
    case 'status':
      if (positionals.length) throw new CliError(1, 'status takes no arguments');
      cmdStatus(flags);
      return;
    case 'clear':
      if (positionals.length) throw new CliError(1, 'clear takes no arguments');
      cmdClear(me);
      return;
    case 'task':
      cmdTask(me, flags, positionals);
      return;
    case 'claim':
      cmdClaim(me, flags, positionals);
      return;
    case 'release':
      cmdRelease(me, positionals);
      return;
    case 'blocked':
      cmdBlocked(me, positionals);
      return;
  }
}

try {
  run(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(err.message.endsWith('\n') ? err.message : `${err.message}\n`);
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write('aether-board: unexpected error\n');
    process.exitCode = 1;
  }
}
