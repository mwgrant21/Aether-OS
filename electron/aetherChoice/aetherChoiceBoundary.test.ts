// @vitest-environment node
// electron/aetherChoice/aetherChoiceBoundary.test.ts
//
// Source-scan guard for the whole AetherChoice feature (src/shared/aetherChoice, src/components/aetherChoice,
// electron/aetherChoice). Every non-test .ts/.tsx file is comment-stripped, then matched against the rules below.
// Limitation: matching is plain regex over the comment-free text, so a string literal that merely mentions a
// forbidden word trips it too (intended: the words have no business in this feature), and a value built at
// runtime from fragments is out of reach. The planted-violation self-test proves every rule fires, and the
// file-list assertion stops the scan passing on an empty tree.
// The write-receiver rule pins the receiver text of every `.write` access per file (with multiplicity), so the
// host has no terminal-write path beyond the engine's one write port. Out of reach: destructuring
// (`const { write } = port`) and a receiver built at runtime.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { MODEL_ALIASES } from '../../src/shared/aetherChoice/types';

const REPO = path.resolve(__dirname, '../..');
const DIRS = ['src/shared/aetherChoice', 'src/components/aetherChoice', 'electron/aetherChoice'];
const REQUIRED = [
  'src/shared/aetherChoice/types.ts',
  'src/shared/aetherChoice/tiers.ts',
  'src/shared/aetherChoice/pickPolicy.ts',
  'src/shared/aetherChoice/pickRecord.ts',
  'src/components/aetherChoice/PickReadout.tsx',
  'electron/aetherChoice/launchCommand.ts',
  'electron/aetherChoice/applyEngine.ts',
  'electron/aetherChoice/pickStore.ts',
];
const FS_OWNER = 'electron/aetherChoice/pickStore.ts';

/** Source text with every comment removed: re-joins the syntax-tree tokens, so comment-like text inside strings survives. */
function stripComments(text: string, name: string): string {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    const kids = n.getChildren(sf);
    if (kids.length === 0) out.push(text.slice(n.getStart(sf), n.getEnd()));
    else kids.forEach(walk);
  };
  walk(sf);
  return out.join(' ');
}

const FORBIDDEN_IMPORT = /node-pty|ptyManager|codexPtyManager|ptyLifecycle|^(?:node:)?child_process$|^electron$/;
const FS_IMPORT = /^(?:node:)?fs(?:\/promises)?$|atomicWrite/;
const ESC_BYTE = new RegExp('\\\\x1b|\\\\u001b|\\\\u\\{1b\\}|\\\\0?33|\\u001b', 'i');

// Receiver text of every `.write` access, per file. Anything not here has zero.
const WRITE_RECEIVERS: Record<string, string[]> = {
  'electron/aetherChoice/applyEngine.ts': ['deps.writePort'], // the engine's one /effort write
  'electron/aetherChoice/runtime.ts': ['deps.writePort', 'port'], // engine-port adapter, user-wrapper delegate
  'electron/aetherChoice/screenWatcher.ts': ['s.mirror'], // headless mirror feed, not a pty
};

// stripComments re-joins tokens with single spaces (`deps . writePort . write (`), so tolerate whitespace.
const WRITE_ACCESS = /(?:\?\s*\.|\.)\s*write\b|\[\s*(['"`])write\1\s*\]/g;
const RECEIVER_CHAIN = /((?:[A-Za-z_$][\w$]*\s*(?:\?\s*\.|\.)\s*)*[A-Za-z_$][\w$]*)\s*$/;
function writeReceivers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(WRITE_ACCESS)) {
    const before = code.slice(0, m.index);
    const c = RECEIVER_CHAIN.exec(before);
    let recv = c ? c[1].replace(/\s+/g, '') : '<complex>';
    if (c && /[.)\]]$/.test(before.slice(0, c.index).trimEnd())) recv = '<complex>'; // chain continues through a call/index
    if (m[1] !== undefined) recv += "['write']"; // bracket form never equals an allowed entry
    if (!/^\s*\(/.test(code.slice(m.index + m[0].length))) recv += '<ref>'; // `.write` not immediately called
    out.push(recv);
  }
  return out.sort();
}

function specifiers(code: string): string[] {
  const re = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*(['"`])([^'"`]+)\1/g;
  return [...code.matchAll(re)].map((m) => m[2]);
}

/** Returns the rule ids a file breaks. `rel` is the repo-relative posix path. */
function check(rel: string, text: string): string[] {
  const code = stripComments(text, rel);
  const hit = new Set<string>();
  if (/settings\.json/.test(code)) hit.add('settings-json');
  if (/ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL/.test(code)) hit.add('forbidden-env');
  if (/\/model\b/.test(code)) hit.add('slash-model');
  if (ESC_BYTE.test(code)) hit.add('escape-byte');
  if (/\bultra\b/i.test(code)) hit.add('ultra');
  for (const s of specifiers(code)) {
    if (FORBIDDEN_IMPORT.test(s)) hit.add('forbidden-import');
    if (FS_IMPORT.test(s) && rel !== FS_OWNER) hit.add('fs-outside-pickstore');
  }
  if (JSON.stringify(writeReceivers(code)) !== JSON.stringify([...(WRITE_RECEIVERS[rel] ?? [])].sort())) hit.add('write-receiver');
  return [...hit].sort();
}

/** Recursive over `dirs` under `root`; skips __fixtures__ and node_modules. Paths are root-relative posix. */
function listFiles(root: string = REPO, dirs: string[] = DIRS): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== '__fixtures__' && e.name !== 'node_modules') walk(`${rel}/${e.name}`);
      } else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.(?:test|spec)\.tsx?$/.test(e.name)) out.push(`${rel}/${e.name}`);
    }
  };
  for (const d of dirs) walk(d);
  return out.sort();
}

describe('AetherChoice boundary: real tree', () => {
  const files = listFiles();

  it('the scan reaches the feature modules (cannot pass vacuously)', () => {
    for (const r of REQUIRED) expect(files).toContain(r);
  });

  it('no scanned file breaks a rule', () => {
    const bad = files.map((f) => ({ f, v: check(f, fs.readFileSync(path.join(REPO, f), 'utf8')) })).filter((x) => x.v.length > 0);
    expect(bad).toEqual([]);
  });

  it('the .write receivers in the real tree are exactly the allowlist', () => {
    const found = Object.fromEntries(
      files.map((f): [string, string[]] => [f, writeReceivers(stripComments(fs.readFileSync(path.join(REPO, f), 'utf8'), f))]).filter(([, r]) => r.length > 0),
    );
    expect(found).toEqual(WRITE_RECEIVERS);
  });

  it('MODEL_ALIASES never lists fable', () => {
    expect([...MODEL_ALIASES] as string[]).not.toContain('fable');
  });
});

describe('AetherChoice boundary: the rules are live', () => {
  const E = 'electron/aetherChoice/applyEngine.ts';
  const PLANTED: Array<[string, string, string]> = [
    ['settings-json', E, "export const p = '~/.claude/settings.json';"],
    ['forbidden-env', E, "export const e = { ANTHROPIC_MODEL: 'sonnet' };"],
    ['forbidden-env', E, "export const e = 'CLAUDE_CODE_EFFORT_LEVEL';"],
    ['slash-model', E, 'export const w = (m: string) => `/model ${m}\\r`;'],
    ['escape-byte', E, "export const esc = '\\x1b';"],
    ['escape-byte', E, "export const esc = '\\u001b';"],
    ['ultra', 'src/shared/aetherChoice/types.ts', "export const L = ['low', 'ultra'];"],
    ['forbidden-import', E, "import * as pty from 'node-pty';"],
    ['forbidden-import', E, "import { x } from '../ptyManager';"],
    ['forbidden-import', E, "import { x } from '../codexPtyManager';"],
    ['forbidden-import', E, "import { x } from '../ptyLifecycle';"],
    ['forbidden-import', E, "import { spawn } from 'node:child_process';"],
    ['forbidden-import', 'src/components/aetherChoice/PickReadout.tsx', "import { ipcRenderer } from 'electron';"],
    ['fs-outside-pickstore', E, "import { readFileSync } from 'node:fs';"],
    ['fs-outside-pickstore', 'src/shared/aetherChoice/pickRecord.ts', "import { writeFileAtomically } from '../../../electron/atomicWrite';"],
    ['write-receiver', 'electron/aetherChoice/pickHost.ts', "export const f = (d: { writePort: { write(s: string, x: string): boolean } }) => d.writePort.write('claude', 'x');"],
    ['write-receiver', 'electron/aetherChoice/screenWatcher.ts', "export const f = (deps: any) => deps.writePort.write('claude', 'x');"],
    ['write-receiver', 'electron/aetherChoice/runtime.ts', 'deps.writePort.write(s, d); port.write(s, d); other.write(s, d);'],
    ['write-receiver', 'electron/aetherChoice/runtime.ts', 'deps.writePort.write(s, d); port.write(s, d); port.write(s, d);'],
    ['write-receiver', E, "export const f = (deps: any) => { const w = deps.writePort.write; w('c', 'x'); };"],
    ['write-receiver', 'electron/aetherChoice/pickHost.ts', "export const f = (g: any) => g().write('claude', 'x');"],
    ['write-receiver', 'src/components/aetherChoice/PickReadout.tsx', "window.aetherElectron.pty.write('x');"],
    ['write-receiver', 'electron/aetherChoice/pickHost.ts', "export const f = (p: any) => p['write']('claude', 'x');"],
  ];

  it('every rule fires on a planted violation', () => {
    for (const [rule, rel, src] of PLANTED) expect({ rule, rel, hit: check(rel, src).includes(rule) }).toEqual({ rule, rel, hit: true });
    expect([...new Set(PLANTED.map((p) => p[0]))].sort()).toEqual([
      'escape-byte', 'forbidden-env', 'forbidden-import', 'fs-outside-pickstore', 'settings-json', 'slash-model', 'ultra', 'write-receiver',
    ]);
  });

  it('allowed receivers pass in their own file, in either order', () => {
    expect(check('electron/aetherChoice/runtime.ts', 'deps.writePort.write(s, d); port.write(s, d);')).toEqual([]);
    expect(check('electron/aetherChoice/runtime.ts', 'port.write(s, d); deps.writePort.write(s, d);')).toEqual([]);
    expect(check('electron/aetherChoice/applyEngine.ts', 'deps.writePort.write(slot, x);')).toEqual([]);
    expect(check('electron/aetherChoice/screenWatcher.ts', 's.mirror.write(e.d);')).toEqual([]);
  });

  it('a commented-out .write( does not count, the same text as live code does', () => {
    const text = '// port.write(x)\n/* deps.writePort.write(x) */\nexport const a = 1;';
    expect(check('electron/aetherChoice/pickHost.ts', text)).toEqual([]);
    expect(check('electron/aetherChoice/pickHost.ts', 'port.write(x); deps.writePort.write(x);')).toEqual(['write-receiver']);
  });

  it('pickStore.ts alone may import node:fs and atomicWrite', () => {
    const src = "import { readFileSync } from 'node:fs';\nimport { writeFileAtomically } from '../atomicWrite';";
    expect(check(FS_OWNER, src)).toEqual([]);
  });

  it('comments are stripped, the same text as live code is not', () => {
    const text = 'Never touches ~/.claude settings.json; typing /model or \\x1b or ultra is banned';
    expect(check(FS_OWNER, `// ${text}\n/* ${text} */\nexport const a = 1;`)).toEqual([]);
    expect(check(FS_OWNER, `export const a = '${text}';`)).toEqual(['escape-byte', 'settings-json', 'slash-model', 'ultra']);
  });

  it('a clean file stays clean, so no rule passes by rejecting everything', () => {
    const src = "import type { X } from '../../src/shared/aetherChoice/types';\nexport const w = (l: string) => `/effort ${l}\\r`;\nexport const s = (deps: any, l: string) => deps.writePort.write('claude', l);";
    expect(check(E, src)).toEqual([]);
  });
});

describe('AetherChoice boundary: the scan recurses', () => {
  it('flags a violation planted in a nested directory and skips __fixtures__ and node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-boundary-'));
    try {
      const put = (rel: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      };
      put('d/a.ts', 'export const a = 1;');
      put('d/sub/deep/bad.ts', "export const p = '~/.claude/settings.json';");
      put('d/__fixtures__/skip.ts', "export const p = 'settings.json';");
      put('d/node_modules/skip.ts', "export const p = 'settings.json';");
      const files = listFiles(root, ['d']);
      expect(files).toEqual(['d/a.ts', 'd/sub/deep/bad.ts']);
      const bad = files.filter((f) => check(f, fs.readFileSync(path.join(root, f), 'utf8')).length > 0);
      expect(bad).toEqual(['d/sub/deep/bad.ts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
