import { execFileSync } from 'node:child_process';

const VALUE_NAME = 'AetherCollector';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * Pure argv builder for reg.exe -- kept separate from the actual
 * execFileSync call below so this logic is testable without ever touching
 * the real registry.
 *
 * Autostart is a per-user Run-key value, not a scheduled task: schtasks
 * /SC ONLOGON needs an elevated shell to CREATE the task ("Access is
 * denied" otherwise -- /RL LIMITED only sets the privilege the task RUNS
 * at), and constraint #8 requires no elevation. HKCU\...\Run is writable by
 * the user who owns it. The collector is a console program, so it is
 * launched through `conhost.exe --headless`: no console window appears at
 * logon for the user to close (which would kill the collector).
 */
export function buildRunKeyCommand(action: 'create' | 'delete', nodePath: string, entrypointPath: string): string[] {
  if (action === 'delete') {
    return ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'];
  }
  return [
    'add', RUN_KEY,
    '/v', VALUE_NAME,
    '/t', 'REG_SZ',
    '/d', `conhost.exe --headless "${nodePath}" "${entrypointPath}"`,
    '/f',
  ];
}

export function installAutostart(nodePath: string, entrypointPath: string): { ok: boolean; error?: string } {
  try {
    execFileSync('reg.exe', buildRunKeyCommand('create', nodePath, entrypointPath));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function uninstallAutostart(): { ok: boolean; error?: string } {
  try {
    execFileSync('reg.exe', buildRunKeyCommand('delete', 'unused', 'unused'));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
