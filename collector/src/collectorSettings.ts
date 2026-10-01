// Collector-side reader for the app-written settings file
// (~/.aether-os/collector-settings.json). Issue #104: memory extraction calls a
// model, so it is opt-in and OFF by default; Electron main owns the file, the
// collector only reads it.
//
// This is the DUPLICATED twin of electron/collectorSettings.ts (same precedent as
// ownSessionFile.ts: the two sides never cross-import). Keep the semantics
// identical: true ONLY when the file parses to a non-null, non-array object whose
// memoryExtractionEnabled === true. Everything else (missing file, malformed JSON,
// "true", 1, a missing key, any read error) is false. Never throws; fails closed.
import { readFileSync } from 'node:fs';

export const COLLECTOR_SETTINGS_FILE = 'collector-settings.json';

export function readMemoryExtractionEnabled(filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).memoryExtractionEnabled === true;
  } catch {
    return false;
  }
}
