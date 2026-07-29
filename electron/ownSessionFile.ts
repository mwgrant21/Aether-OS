import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function ownSessionFilePath(aetherDir: string): string {
  return join(aetherDir, 'own-session.json');
}

/**
 * Reads back the session id this app instance last stamped into
 * own-session.json. Mirrors collector/src/ownSessionFile.ts#readOwnSessionId
 * and scripts/aether-permission-hook.mjs's inline copy of the same logic --
 * those live in separate standalone processes (a plain-Node collector build
 * and a dependency-free hook script) and deliberately duplicate this rather
 * than cross-import, so this is the electron/-side twin of the same pattern.
 * Never throws: missing file / malformed JSON / wrong shape all resolve to
 * null, same fall-through discipline as the other two copies.
 */
export function readOwnSessionId(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sessionId = (parsed as Record<string, unknown>).sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Atomic tmp-then-rename write, mirroring scripts/aether-statusline.mjs's
 * persistSnapshot -- a direct write to the target path would let the
 * collector's reader observe a partially-written file mid-write on its own
 * poll cycle. Never throws: a write failure here must not break the tick
 * loop it's called from.
 */
export function writeOwnSessionFile(aetherDir: string, sessionId: string | null, nowMs: number): void {
  try {
    mkdirSync(aetherDir, { recursive: true });
    const targetPath = ownSessionFilePath(aetherDir);
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ sessionId, updatedAtMs: nowMs }), 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    // Swallowed: a persistence failure here must not crash tickAndPushAgents.
  }
}
