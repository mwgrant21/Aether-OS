import fsp from 'node:fs/promises';
import path from 'node:path';

export function sanitizeState(raw: unknown): Record<string, number> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(src)) {
    if (typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts;
  }
  return out;
}

async function writeState(statePath: string, state: Record<string, number>): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function loadOptimizeState(statePath: string): Promise<Record<string, number>> {
  try {
    const raw = await fsp.readFile(statePath, 'utf8');
    return sanitizeState(JSON.parse(raw));
  } catch {
    return {};
  }
}

// Records/resets the appliedAt timestamp for a finding id. Called on every
// successful Apply-fix action, including a reapply where the guidance bullet
// was already present, so "Apply" always means "recurrence check starts now."
export async function recordAppliedAt(
  statePath: string,
  findingId: string,
  whenMs: number,
): Promise<Record<string, number>> {
  const current = await loadOptimizeState(statePath);
  current[findingId] = whenMs;
  await writeState(statePath, current);
  return current;
}
