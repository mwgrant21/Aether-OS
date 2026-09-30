#!/usr/bin/env node
// Generates collector/src/severity/*.ts from electron/severity/*.ts.
// The collector is a standalone package (NodeNext ESM, own build), so it
// cannot import from electron/. It gets a generated copy instead, and
// electron/severity/severity.parity.test.ts fails if the two drift.
// Usage: node scripts/sync-severity-core.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_FILES = ['parseDispatchOutcome.ts', 'computeSeverity.ts', 'isStalled.ts', 'baselineMath.ts'];

// Group 2 of each pattern is the module specifier.
// Static forms are line-anchored, so a match inside a comment or a string
// literal is never seen:
//   import x from 'm' / export * from 'm' (may span lines; no quote before 'from')
//   import 'm' (side-effect)
// The dynamic form import('m') cannot be line-anchored, so it is checked
// against comment prefixes and open string literals on its own line.
const STATEMENT_FROM = /^([ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*['"])([^'"\n]+)(['"])/gm;
const STATEMENT_SIDE = /^([ \t]*import\s*['"])([^'"\n]+)(['"])/gm;
const DYNAMIC = /(\bimport\s*\(\s*['"`])([^'"`\n]+)(['"`]\s*\))/g;

// True when offset sits inside a comment or string literal, judged from the
// start of its line. Scans left to right so a // inside a string (a URL) does
// not count as a comment start.
function inCommentOrString(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const before = source.slice(lineStart, offset);
  if (/^\s*\*/.test(before)) return true;
  let quote = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '/' && (before[i + 1] === '/' || before[i + 1] === '*')) {
      return true;
    }
  }
  return quote !== null;
}

function assertCheckable(spec) {
  if (spec.includes('$' + '{')) throw new Error('sync-severity-core: computed import specifier cannot be checked: ' + spec);
}

// Calls fn(spec) for every specifier; a string result replaces it.
function mapSpecifiers(source, fn) {
  const swap = (match, head, spec, tail) => {
    assertCheckable(spec);
    const next = fn(spec);
    return typeof next === 'string' ? head + next + tail : match;
  };
  return source
    .replace(STATEMENT_FROM, swap)
    .replace(STATEMENT_SIDE, swap)
    .replace(DYNAMIC, (match, head, spec, tail, offset, whole) =>
      inCommentOrString(whole, offset) ? match : swap(match, head, spec, tail),
    );
}

// Every import specifier in source order (relative or not).
export function importSpecifiers(source) {
  const hits = [];
  for (const re of [STATEMENT_FROM, STATEMENT_SIDE, DYNAMIC]) {
    for (const m of source.matchAll(re)) {
      if (re === DYNAMIC && inCommentOrString(source, m.index)) continue;
      assertCheckable(m[2]);
      hits.push({ at: m.index, spec: m[2] });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.spec);
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
