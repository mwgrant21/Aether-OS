import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHookInstallState, installHooks, uninstallHooks, MANAGED_HOOK_EVENTS } from './hookInstaller.js';

const settingsPath = join(homedir(), '.claude', 'settings.json');
// This repo's own scripts/ directory, resolved relative to this compiled
// file's location (collector/dist/cli.js -> ../../scripts/aether-hook-emit.mjs).
const scriptPath = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'aether-hook-emit.mjs');

async function main() {
  const command = process.argv[2];

  if (!existsSync(scriptPath)) {
    console.error(`aether-hook-emit.mjs not found at ${scriptPath} -- refusing to modify settings.json`);
    process.exitCode = 1;
    return;
  }

  if (command === 'status') {
    const state = await readHookInstallState(settingsPath, scriptPath);
    console.log(`settings.json: ${settingsPath}`);
    console.log(`script: ${scriptPath}`);
    for (const eventName of MANAGED_HOOK_EVENTS) {
      console.log(`  ${eventName}: ${state.installedEvents.includes(eventName) ? 'installed' : 'not installed'}`);
    }
    return;
  }

  if (command === 'install-hooks') {
    const result = await installHooks(settingsPath, scriptPath);
    if (!result.ok) {
      console.error(`install failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(result.backupPath ? `installed (backup: ${result.backupPath})` : 'installed');
    return;
  }

  if (command === 'uninstall-hooks') {
    const result = await uninstallHooks(settingsPath);
    if (!result.ok) {
      console.error(`uninstall failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(result.backupPath ? `uninstalled (backup: ${result.backupPath})` : 'uninstalled (nothing was installed)');
    return;
  }

  console.error('usage: node dist/cli.js <status|install-hooks|uninstall-hooks>');
  process.exitCode = 1;
}

main();
