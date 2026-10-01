#!/usr/bin/env node
// Generates collector/src/severity/*.ts from electron/severity/*.ts.
// The collector is a standalone package (NodeNext ESM, own build), so it
// cannot import from electron/. It gets a generated copy instead, and
// electron/severity/severity.parity.test.ts fails if the two drift.
// Usage: node scripts/sync-severity-core.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_FILES = ['parseDispatchOutcome.ts', 'computeSeverity.ts', 'isStalled.ts', 'baselineMath.ts', 'subagentLink.ts'];

// Group 2 of each pattern is the module specifier. A match counts only when its
// keyword sits in code (not inside a comment or string literal), judged by
// codeMask() over the whole source:
//   import x from 'm' / export * from 'm' (may span lines; no quote before 'from')
//   import 'm' (side-effect)
// Those two must also start a line, ignoring whitespace and comments before them
// (so code after a closed /* */ on the same line is still found).
//   import('m') (dynamic; anywhere in code)
const STATEMENT_FROM = /((?:import|export)\b[^;'"`]*?\bfrom\s*['"])([^'"\n]+)(['"])/g;
const STATEMENT_SIDE = /(import\s*['"])([^'"\n]+)(['"])/g;
const DYNAMIC = /(\bimport\s*\(\s*['"`])([^'"`\n]+)(['"`]\s*\))/g;

// mask[i] is 1 where source[i] is code, 0 inside a comment or string literal.
// Scans left to right, so a // inside a string (a URL) is not a comment start
// and a block comment may span lines.
function codeMask(source) {
  const mask = new Uint8Array(source.length);
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close < 0 ? source.length : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < source.length && source[i] !== c && (c === '`' || source[i] !== '\n')) {
        i += source[i] === '\\' ? 2 : 1;
      }
      i++;
    } else {
      mask[i++] = 1;
    }
  }
  return mask;
}

// Only whitespace or comment characters between the line start and index.
function startsLine(source, mask, index) {
  for (let j = index - 1; j >= 0 && source[j] !== '\n'; j--) {
    if (mask[j] === 1 && !/\s/.test(source[j])) return false;
  }
  return true;
}

function assertCheckable(spec) {
  if (spec.includes('$' + '{')) throw new Error('sync-severity-core: computed import specifier cannot be checked: ' + spec);
}

// [{ at, start, spec }] in source order: start is where the specifier begins.
function findSpecifiers(source) {
  const mask = codeMask(source);
  const hits = new Map();
  for (const re of [STATEMENT_FROM, STATEMENT_SIDE, DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const ok = mask[m.index] === 1 && (re === DYNAMIC || startsLine(source, mask, m.index));
      if (!ok) {
        // A match that starts in a comment must not swallow a real one after it.
        re.lastIndex = m.index + 1;
        continue;
      }
      assertCheckable(m[2]);
      hits.set(m.index + m[1].length, { at: m.index, start: m.index + m[1].length, spec: m[2] });
    }
  }
  return [...hits.values()].sort((a, b) => a.start - b.start);
}

// Calls fn(spec) for every specifier; a string result replaces it.
function mapSpecifiers(source, fn) {
  let out = source;
  for (const h of findSpecifiers(source).reverse()) {
    const next = fn(h.spec);
    if (typeof next === 'string') out = out.slice(0, h.start) + next + out.slice(h.start + h.spec.length);
  }
  return out;
}

// Every import specifier in source order (relative or not).
export function importSpecifiers(source) {
  return findSpecifiers(source).map((h) => h.spec);
}

export function renderCollectorCopy(source, fileName) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const body = mapSpecifiers(source, (spec) =>
    spec.startsWith('./') && !spec.endsWith('.js') ? spec + '.js' : undefined,
  );
  return (
    `// GENERATED from electron/severity/${fileName} by scripts/sync-severity-core.mjs -- do not edit.${eol}` +
    `// Edit the electron copy, then run: node scripts/sync-severity-core.mjs${eol}` +
    body
  );
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(repoRoot, 'collector', 'src', 'severity');
  mkdirSync(outDir, { recursive: true });
  for (const f of CORE_FILES) {
    const src = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
    writeFileSync(join(outDir, f), renderCollectorCopy(src, f), 'utf8');
  }
  console.log(`sync-severity-core: wrote ${CORE_FILES.length} files to collector/src/severity`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
