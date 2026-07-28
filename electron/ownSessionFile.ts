import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function ownSessionFilePath(aetherDir: string): string {
  return join(aetherDir, 'own-session.json');
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
