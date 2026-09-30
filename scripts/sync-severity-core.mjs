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

export function renderCollectorCopy(source, fileName) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const body = source.replace(/(from\s+['"])(\.\/[^'"]+?)(['"])/g, (match, head, spec, tail) =>
    spec.endsWith('.js') ? match : `${head}${spec}.js${tail}`,
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
