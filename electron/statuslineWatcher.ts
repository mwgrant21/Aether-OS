import { readFileSync, statSync, watchFile, unwatchFile } from 'fs';
import { parseStatuslinePayload, type StatuslineSnapshot } from '../src/shared/statuslinePayload';

/**
 * fs.watchFile polls rather than relying on OS filesystem-change events.
 * `fs.watch` is explicitly avoided here: on Windows it does not reliably
 * report the atomic write-then-renameSync pattern Task 3's script uses to
 * persist the payload (write to `.tmp`, then `renameSync` over the target).
 * A ~2s poll interval is frequent enough for an event-driven feed that is
 * itself debounced at 300ms on the writer's side.
 */
const WATCH_INTERVAL_MS = 2000;

/**
 * Reads and parses the statusline payload file. Never throws: a missing
 * file, a partial/unreadable read, or a JSON parse failure all resolve to
 * `null`, which callers must treat as a silent no-op rather than an error --
 * the renderer keeps its last good snapshot.
 *
 * `capturedAtMs` comes from the payload itself when the writer stamped one;
 * otherwise it falls back to the file's own `mtimeMs`. Never `Date.now()`
 * here -- that would make every read look artificially fresh and defeat the
 * staleness detection built on `capturedAtMs` elsewhere in this plan.
 */
function readSnapshot(payloadPath: string): StatuslineSnapshot | null {
  try {
    const stat = statSync(payloadPath);
    const raw = readFileSync(payloadPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    const rawCapturedAtMs =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>).capturedAtMs
        : undefined;
    const capturedAtMs =
      typeof rawCapturedAtMs === 'number' && isFinite(rawCapturedAtMs) ? rawCapturedAtMs : stat.mtimeMs;

    return parseStatuslinePayload(parsed, capturedAtMs);
  } catch {
    // Missing file, a read racing the writer's rename, or malformed JSON --
    // all silent no-ops by design.
    return null;
  }
}

/**
 * Starts watching `payloadPath` for the statusline script's snapshots.
 * Reads once immediately (so a payload written before the app launched is
 * picked up right away) and then polls via `fs.watchFile`. Returns an
 * unsubscribe function that must be called on app quit.
 */
export function startStatuslineWatcher(
  payloadPath: string,
  onSnapshot: (s: StatuslineSnapshot) => void
): () => void {
  const checkAndEmit = (): void => {
    const snapshot = readSnapshot(payloadPath);
    if (snapshot !== null) onSnapshot(snapshot);
  };

  // Pick up a snapshot that already exists before this watcher starts.
  checkAndEmit();

  const listener = (): void => checkAndEmit();
  watchFile(payloadPath, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);

  return (): void => {
    unwatchFile(payloadPath, listener);
  };
}
