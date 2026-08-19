// scripts/grant-appcontainer-acl.js
//
// Electron's GPU and renderer children run inside a Windows AppContainer sandbox.
// An AppContainer token can only map DLLs from a directory that grants read+execute
// to ALL APPLICATION PACKAGES (S-1-15-2-1). npm does not set that ACE, so on machines
// where it is not inherited from a parent directory the sandboxed children fail to
// load their DLLs and the GPU process dies immediately (Electron reports this as
// "GPU process exited unexpectedly" / "GPU process isn't usable. Goodbye.").
//
// npm install recreates node_modules and drops the ACE, so this runs on postinstall.
// Chrome ships with this ACE on its own install directory for the same reason.
//
// Electron 42 stopped downloading its binary during its own postinstall -- dist/ is
// now fetched on first run instead. That would leave this script with nothing to
// grant at install time and no second chance before the app launches, so package.json
// chains `install-electron && node scripts/grant-appcontainer-acl.js`. Do not drop
// the `install-electron` half: without it this script silently skips and the very
// first launch after a fresh install dies with exit_code=-1073741515.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The ACE is a Windows concept; nothing to do elsewhere.
if (process.platform !== 'win32') process.exit(0);

const distDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');

if (!fs.existsSync(distDir)) {
  console.log(`[acl] skipped: ${distDir} not present`);
  process.exit(0);
}

try {
  execFileSync(
    'icacls',
    [distDir, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/C'],
    { stdio: 'pipe' },
  );
  console.log('[acl] granted ALL APPLICATION PACKAGES (RX) on electron/dist');
} catch (err) {
  // A failure here only means the app may not launch; it must not break `npm install`.
  console.warn(`[acl] WARNING: could not grant the AppContainer ACE: ${err.message}`);
  console.warn('[acl] If Electron dies with a GPU process crash, run manually:');
  console.warn(`[acl]   icacls "${distDir}" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /C`);
}
