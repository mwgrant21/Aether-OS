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

// Windows ignores Run-key command lines over 260 characters, and reg.exe
// stores them without complaint, so an over-long command would report a
// successful install that never starts at logon.
// https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys
export const MAX_RUN_COMMAND_LENGTH = 260;

/** Returns an error message when the argv's /d command is too long to run at logon, else null. */
export function checkRunCommandLength(argv: string[]): string | null {
  const command = argv[argv.indexOf('/d') + 1] ?? '';
  return command.length > MAX_RUN_COMMAND_LENGTH
    ? `Run-key command is ${command.length} characters; Windows ignores commands over ${MAX_RUN_COMMAND_LENGTH} at logon. Move the checkout to a shorter path.`
    : null;
}

export function installAutostart(nodePath: string, entrypointPath: string): { ok: boolean; error?: string } {
  const argv = buildRunKeyCommand('create', nodePath, entrypointPath);
  const tooLong = checkRunCommandLength(argv);
  if (tooLong) return { ok: false, error: tooLong };
  try {
    execFileSync('reg.exe', argv);
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
