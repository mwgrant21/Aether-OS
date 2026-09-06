// Post-build assertions for the Windows CI lane.
//
// `electron-vite build` exits 0 even when a tree it was supposed to populate
// is empty, and an incomplete out/ presents at runtime as a blank white
// window with no error -- a symptom this project has already spent real
// debugging time on, and one that is indistinguishable from a product bug
// until someone thinks to look at the build output. So the lane asserts the
// artifacts rather than trusting the exit code.
//
// Also smoke-tests the two native/binary dependencies that Linux CI cannot
// observe at all: the Electron binary (fetched on first run since Electron 42,
// not during its own postinstall) and node-pty's prebuild.
//
// Cross-platform on purpose -- it is useful to run locally on any OS -- but
// the Electron binary name differs, so that check is platform-aware.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const failures = [];

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else if (statSync(full).size > 0) total += 1;
  }
  return total;
}

for (const tree of ['out/main', 'out/preload', 'out/renderer']) {
  if (!existsSync(tree)) {
    failures.push(`${tree} does not exist -- electron-vite build did not produce it`);
    continue;
  }
  const files = countFiles(tree);
  if (files === 0) {
    failures.push(`${tree} exists but contains no non-empty files`);
  } else {
    console.log(`[artifacts] ${tree}: ${files} file(s)`);
  }
}

const electronBinary =
  process.platform === 'win32'
    ? join('node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? join('node_modules', 'electron', 'dist', 'Electron.app')
      : join('node_modules', 'electron', 'dist', 'electron');

if (existsSync(electronBinary)) {
  console.log(`[binary] electron present at ${electronBinary}`);
} else {
  failures.push(
    `Electron binary missing at ${electronBinary}. Since Electron 42 the binary is fetched on ` +
      `first run rather than during postinstall, so package.json chains \`install-electron\` -- ` +
      `check that it still runs.`
  );
}

try {
  const pty = require('node-pty');
  if (typeof pty.spawn !== 'function') throw new Error('node-pty loaded but exposes no spawn()');
  console.log('[native] node-pty loaded and exposes spawn()');
} catch (err) {
  failures.push(`node-pty failed to load: ${err.message}`);
}

if (failures.length > 0) {
  console.error('\nArtifact verification FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('\nArtifact verification passed.');
