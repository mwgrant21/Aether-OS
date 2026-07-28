import { readFileSync } from 'node:fs';

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
