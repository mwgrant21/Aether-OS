import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startStatuslineWatcher } from './statuslineWatcher';
import type { StatuslineSnapshot } from '../src/shared/statuslinePayload';

/**
 * Covers readSnapshot's capturedAtMs-from-payload-vs-mtimeMs-fallback logic --
 * load-bearing for the entire staleness feature (deriveDepletion,
 * STATUSLINE_STALE_AFTER_MS) and, before this file, entirely untested.
 *
 * startStatuslineWatcher's own startup checkAndEmit() runs synchronously
 * before it sets up fs.watchFile, so calling it against a file that already
 * exists is enough to observe readSnapshot's result via the onSnapshot
 * callback -- no need to wait for a poll interval.
 */
describe('statuslineWatcher capturedAtMs resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statusline-watcher-test-'));
  const file = join(dir, 'statusline.json');
  let stop: (() => void) | null = null;

  afterEach(() => {
    if (stop) {
      stop();
      stop = null;
    }
    rmSync(file, { force: true });
  });

  function captureSnapshot(payloadJson: string): StatuslineSnapshot | null {
    writeFileSync(file, payloadJson, 'utf8');
    let captured: StatuslineSnapshot | null = null;
    stop = startStatuslineWatcher(file, (snapshot) => {
      captured = snapshot;
    });
    return captured;
  }

  it('uses the payload capturedAtMs field as-is when it is a finite number', () => {
    const fixedCapturedAtMs = 1700000000000;
    const snapshot = captureSnapshot(JSON.stringify({ capturedAtMs: fixedCapturedAtMs }));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.capturedAtMs).toBe(fixedCapturedAtMs);
    // Sanity: the fixed timestamp is nowhere near the file's real mtime, so
    // this also confirms the mtime fallback was NOT used here.
    const mtimeMs = statSync(file).mtimeMs;
    expect(snapshot!.capturedAtMs).not.toBe(mtimeMs);
  });

  it('falls back to the file mtimeMs when the payload has no capturedAtMs field', () => {
    const snapshot = captureSnapshot(JSON.stringify({ sessionId: 'abc' }));
    expect(snapshot).not.toBeNull();
    const mtimeMs = statSync(file).mtimeMs;
    expect(snapshot!.capturedAtMs).toBe(mtimeMs);
  });

  it('falls back to the file mtimeMs when capturedAtMs is a non-finite/non-numeric value', () => {
    // JSON has no literal for Infinity/NaN, so the only way a non-finite
    // "number" reaches this code from a real payload is as a non-number type
    // (e.g. a string) -- this exercises the `typeof === 'number' && isFinite`
    // guard's rejection path.
    const snapshot = captureSnapshot(JSON.stringify({ capturedAtMs: 'not-a-number' }));
    expect(snapshot).not.toBeNull();
    const mtimeMs = statSync(file).mtimeMs;
    expect(snapshot!.capturedAtMs).toBe(mtimeMs);
  });
});
