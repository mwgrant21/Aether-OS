import { execFileSync } from 'node:child_process';

const TASK_NAME = 'AetherCollector';

/**
 * Pure argv builder for schtasks.exe -- kept separate from the actual
 * execFileSync call below so this logic is testable without ever touching
 * the real Windows Task Scheduler. /RL LIMITED explicitly requests standard
 * (non-admin) privilege -- constraint #8 requires no elevation.
 */
export function buildScheduledTaskCommand(action: 'create' | 'delete', nodePath: string, entrypointPath: string): string[] {
  if (action === 'delete') {
    return ['/Delete', '/TN', TASK_NAME, '/F'];
  }
  return [
    '/Create',
    '/TN', TASK_NAME,
    '/TR', `"${nodePath}" "${entrypointPath}"`,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
  ];
}

export function installAutostart(nodePath: string, entrypointPath: string): { ok: boolean; error?: string } {
  try {
    execFileSync('schtasks.exe', buildScheduledTaskCommand('create', nodePath, entrypointPath));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function uninstallAutostart(): { ok: boolean; error?: string } {
  try {
    execFileSync('schtasks.exe', buildScheduledTaskCommand('delete', 'unused', 'unused'));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
