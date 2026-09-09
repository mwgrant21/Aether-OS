// scripts/grant-appcontainer-acl.js
//
// Electron's GPU and renderer children run inside a Windows AppContainer sandbox.
// An AppContainer token can only map DLLs from a directory that grants read+execute
// to ALL APPLICATION PACKAGES (S-1-15-2-1). npm does not set that ACE, so on machines
// where it is not inherited from a parent directory the sandboxed children fail to
// load their DLLs and the GPU process dies immediately (Electron reports this as
// "GPU process exited unexpectedly" / "GPU process isn't usable. Goodbye.").
//
// Chrome ships with this ACE on its own install directory for the same reason.
//
// Two callers, two modes:
//
//   node scripts/grant-appcontainer-acl.js
//     Postinstall mode. Grants the ACE on node_modules/electron/dist for
//     `npm run electron:dev`. npm install recreates node_modules and drops the
//     ACE, so this runs on every install. BEST EFFORT: a missing directory is a
//     skip and an icacls failure is a warning, because neither may break
//     `npm install`.
//
//   node scripts/grant-appcontainer-acl.js release/win-unpacked
//     Build mode. Grants the ACE on a packaged output tree. `npm run dist:dir`
//     stops before NSIS, so build/installer.nsh's customInstall hook -- the only
//     other place this ACE is granted -- never runs, and the unpacked build
//     docs/packaging.md advertises as the fast smoke-test path would hit exactly
//     the DLL-loading failure described above. FAILS LOUDLY: an explicitly named
//     target that is missing, or an icacls call that fails, exits non-zero. The
//     build just claimed to produce this directory, so a silent skip here would
//     hand back an unlaunchable smoke build and call it a success.
//
// Electron 42 stopped downloading its binary during its own postinstall -- dist/ is
// now fetched on first run instead. That would leave postinstall mode with nothing to
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

// An explicit argument is resolved against the CWD (npm scripts run at the repo
// root), so `release/win-unpacked` means what it reads as from package.json.
const requestedTarget = process.argv[2];
const targetDir = requestedTarget
  ? path.resolve(process.cwd(), requestedTarget)
  : path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const label = requestedTarget ? requestedTarget : 'electron/dist';

if (!fs.existsSync(targetDir)) {
  if (requestedTarget) {
    console.error(`[acl] ERROR: ${targetDir} does not exist -- nothing to grant.`);
    process.exit(1);
  }
  console.log(`[acl] skipped: ${targetDir} not present`);
  process.exit(0);
}

try {
  execFileSync(
    'icacls',
    [targetDir, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/T', '/C'],
    { stdio: 'pipe' },
  );
  console.log(`[acl] granted ALL APPLICATION PACKAGES (RX) on ${label}`);
} catch (err) {
  const manual = `[acl]   icacls "${targetDir}" /grant "*S-1-15-2-1:(OI)(CI)(RX)" /T /C`;
  if (requestedTarget) {
    // Build mode: the caller asked for a launchable tree and did not get one.
    console.error(`[acl] ERROR: could not grant the AppContainer ACE: ${err.message}`);
    console.error('[acl] The packaged build will die with a GPU process crash. Run manually:');
    console.error(manual);
    process.exit(1);
  }
  // Postinstall mode: a failure here only means the app may not launch; it must
  // not break `npm install`.
  console.warn(`[acl] WARNING: could not grant the AppContainer ACE: ${err.message}`);
  console.warn('[acl] If Electron dies with a GPU process crash, run manually:');
  console.warn(manual);
}
