#!/usr/bin/env node
// Dev-only capture harness for AetherChoice idle-screen fixtures (spec T2).
// NOT wired into package.json or the app. Run by hand in a PLAIN PowerShell
// window (not inside Aether).
//
// Usage (the exact command Matt runs, from the repo root):
//   node scripts/aether-choice-capture.mjs "$HOME\.claude\handoffs\aether-gui\idle-fixtures-2026-11-03"
//   node scripts/aether-choice-capture.mjs --watch-statusline "$HOME\.claude\handoffs\aether-gui\idle-fixtures-2026-11-03\statusline"
//
// What it does: spawns powershell.exe under node-pty in a scratch cwd
// (os.tmpdir()), relays your keystrokes, mirrors the output in an
// @xterm/headless terminal. Hotkey Ctrl+] then type a label then Enter writes
//   <outDir>/<label>.txt       visible rows, right-trimmed, one per line
//   <outDir>/<label>.raw.txt   last 4 KB of raw output, control chars escaped (ESC = \x1b)
//   <outDir>/<label>.title.txt last OSC 0/2 window title seen
// It never starts claude (you type it), never touches ~/.claude, and the only
// paths it writes are under outDir. outDir must be under os.tmpdir() or
// ~/.claude/handoffs/ (and never inside the repo); anything else is refused.
//
// --watch-statusline <outDir>: every 500 ms copy ~/.aether-os/statusline.json
// to <outDir>/statusline-<n>-t<monotonicMs>.json, only when the content changed.
// The source file is only ever read.
//
// CAPTURE CHECKLIST (Matt, attended)
//  0. Before: copy ~/.claude/settings.json and ~/.claude.json somewhere safe
//     (or note their sha256). Typing /effort or /model rewrites your global
//     default, so you will diff both files afterwards.
//  1. Start the harness (command above). In the shell, run `claude` yourself.
//  2. For each label, get the screen into the state, press Ctrl+], type the
//     label, press Enter (the harness prints only the file names):
//       idle-empty           fresh empty prompt, nothing typed
//       draft-text           half-typed text at the prompt, not submitted
//       generating           mid-turn, the interrupt hint visible
//       model-picker         type the model command, picker open, capture, Esc out
//       switch-model-modal   a real model switch on a THROWAWAY thread, modal open
//       permission-prompt    a tool permission prompt showing
//       shell-prompt         after /exit, the PowerShell prompt visible
//       usage-pane           the usage / status pane open
//       banner-version       the startup banner with the Claude version visible
// 3. Timing run: in a second window start `--watch-statusline`, then in the
//     capture window run
//       claude --session-id <fresh-uuid> --model sonnet --effort low
//     Record (a) seconds from launch to the first statusline-*.json whose
//     session_id equals that uuid, (b) whether the raw JSON has any
//     effort-like field (grep -i effort on the captured files).
// 4. After: diff settings.json and ~/.claude.json against step 0. Restore
//     /effort to high in a plain window if it moved.
// Exit the harness with Ctrl+C twice or by closing the shell (`exit`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const RAW_TAIL_BYTES = 4096;
const HOTKEY = 0x1d; // Ctrl+]

/** True when `child` equals or is inside `parent` (both absolute, already resolved). */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath of the nearest existing ancestor, with the not-yet-existing tail re-appended. */
function resolveReal(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Validate an output directory. Returns the resolved real path or throws.
 * Rejects the repo and ~/.claude (except ~/.claude/handoffs); accepts only
 * os.tmpdir() or ~/.claude/handoffs. `..` segments and symlinks are resolved
 * first. Options exist so tests can use fake roots.
 */
export function checkOutDir(outDir, opts = {}) {
  if (typeof outDir !== 'string' || outDir.trim() === '') throw new Error('outDir is required');
  const repoRoot = resolveReal(opts.repoRoot ?? REPO_ROOT);
  const home = opts.home ?? os.homedir();
  const claudeDir = resolveReal(path.join(home, '.claude'));
  const handoffs = resolveReal(path.join(home, '.claude', 'handoffs'));
  const tmp = resolveReal(opts.tmpDir ?? os.tmpdir());
  const real = resolveReal(outDir);
  if (isInside(repoRoot, real)) throw new Error('outDir is inside the repo');
  const allowed = isInside(handoffs, real) || isInside(tmp, real);
  if (isInside(claudeDir, real) && !isInside(handoffs, real)) throw new Error('outDir is inside ~/.claude');
  if (!allowed) throw new Error('outDir must be under the temp dir or ~/.claude/handoffs');
  return real;
}

/** Visible rows of a headless xterm terminal, right-trimmed. */
export function renderRows(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    rows.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  return rows;
}

/** Show control characters as escapes (ESC -> \x1b); keeps \n readable as \n. */
export function escapeRaw(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\n') out += '\\n\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

/** Labels become file names: keep a safe subset only. */
export function sanitizeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 64);
}

/** Polling step for --watch-statusline. tick() copies only when content changed. */
export function createStatuslineWatcher({ src, outDir, nowMs }) {
  let last = null;
  let n = 0;
  return {
    tick() {
      let content;
      try {
        content = fs.readFileSync(src, 'utf8');
      } catch {
        return null;
      }
      if (content === last) return null;
      last = content;
      n += 1;
      const name = `statusline-${String(n).padStart(4, '0')}-t${Math.round(nowMs())}.json`;
      fs.writeFileSync(path.join(outDir, name), content);
      return name;
    },
  };
}

function monotonicClock() {
  const t0 = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - t0) / 1_000_000n);
}

function runWatch(outDirArg) {
  const outDir = checkOutDir(outDirArg);
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(os.homedir(), '.aether-os', 'statusline.json');
  const w = createStatuslineWatcher({ src, outDir, nowMs: monotonicClock() });
  process.stdout.write(`watching statusline, writing to ${outDir}\n`);
  setInterval(() => {
    const name = w.tick();
    if (name) process.stdout.write(`${name}\n`);
  }, 500);
}

async function runCapture(outDirArg) {
  const outDir = checkOutDir(outDirArg);
  fs.mkdirSync(outDir, { recursive: true });
  // Lazy: the pure exports above must load without the native module.
  const require = createRequire(import.meta.url);
  const pty = require('node-pty');
  const headless = require('@xterm/headless');
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  const term = new headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  let title = '';
  term.onTitleChange((t) => { title = t; });
  const proc = pty.spawn('powershell.exe', ['-NoLogo'], {
    name: 'xterm-256color', cols, rows, cwd: os.tmpdir(), env: process.env,
  });
  let rawTail = '';
  proc.onData((d) => {
    rawTail = (rawTail + d).slice(-RAW_TAIL_BYTES);
    term.write(d);
    process.stdout.write(d);
  });
  proc.onExit(() => process.exit(0));
  process.stdout.on('resize', () => {
    proc.resize(process.stdout.columns, process.stdout.rows);
    term.resize(process.stdout.columns, process.stdout.rows);
  });

  let labelMode = false;
  let labelBuf = '';
  function save(label) {
    const safe = sanitizeLabel(label);
    if (!safe) return;
    // term.write is async; flush by writing an empty chunk with a callback.
    term.write('', () => {
      fs.writeFileSync(path.join(outDir, `${safe}.txt`), renderRows(term).join('\n') + '\n');
      fs.writeFileSync(path.join(outDir, `${safe}.raw.txt`), escapeRaw(rawTail));
      fs.writeFileSync(path.join(outDir, `${safe}.title.txt`), title + '\n');
      process.stderr.write(`\r\n[capture] wrote ${safe}.txt, ${safe}.raw.txt, ${safe}.title.txt\r\n`);
    });
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (buf) => {
    const fwd = [];
    for (const b of buf) {
      if (labelMode) {
        if (b === 0x0d || b === 0x0a) { labelMode = false; save(labelBuf); labelBuf = ''; }
        else if (b === 0x7f || b === 0x08) labelBuf = labelBuf.slice(0, -1);
        else if (b >= 0x20 && b < 0x7f) labelBuf += String.fromCharCode(b);
      } else if (b === HOTKEY) {
        labelMode = true;
        labelBuf = '';
        process.stderr.write('\r\n[capture] label then Enter: ');
      } else fwd.push(b);
    }
    if (fwd.length) proc.write(Buffer.from(fwd).toString('latin1'));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const watch = args[0] === '--watch-statusline';
  const dir = watch ? args[1] : args[0];
  try {
    if (watch) runWatch(dir);
    else await runCapture(dir);
  } catch (e) {
    process.stderr.write(`aether-choice-capture: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
