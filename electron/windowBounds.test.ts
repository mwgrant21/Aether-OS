import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clampBoundsToDisplays, loadWindowBounds, saveWindowBounds, type Bounds, type Rect } from './windowBounds';

const DISPLAY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe('clampBoundsToDisplays', () => {
  it('passes through bounds fully on-screen', () => {
    const saved: Bounds = { x: 100, y: 100, width: 1400, height: 900 };
    expect(clampBoundsToDisplays(saved, [DISPLAY])).toEqual(saved);
  });

  it('returns null for bounds fully off-screen', () => {
    const saved: Bounds = { x: 5000, y: 5000, width: 1400, height: 900 };
    expect(clampBoundsToDisplays(saved, [DISPLAY])).toBeNull();
  });

  it('accepts bounds with at least 100x100px intersecting a display', () => {
    // 100px of width/height overlap with the display's top-left corner.
    const saved: Bounds = { x: -1300, y: -800, width: 1400, height: 900 };
    expect(clampBoundsToDisplays(saved, [DISPLAY])).toEqual(saved);
  });

  it('rejects bounds with just under the 100x100px intersection threshold', () => {
    const saved: Bounds = { x: -1301, y: -800, width: 1400, height: 900 };
    expect(clampBoundsToDisplays(saved, [DISPLAY])).toBeNull();
  });

  it('clamps oversized bounds to the largest display', () => {
    const saved: Bounds = { x: 0, y: 0, width: 4000, height: 3000 };
    const result = clampBoundsToDisplays(saved, [DISPLAY]);
    expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('picks the largest display when clamping across multiple displays', () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 600 };
    const large: Rect = { x: 800, y: 0, width: 3840, height: 2160 };
    const saved: Bounds = { x: 800, y: 0, width: 5000, height: 3000 };
    const result = clampBoundsToDisplays(saved, [small, large]);
    expect(result).toEqual({ x: 800, y: 0, width: 3840, height: 2160 });
  });

  it('returns null when saved is null', () => {
    expect(clampBoundsToDisplays(null, [DISPLAY])).toBeNull();
  });

  it('returns null when there are no displays', () => {
    const saved: Bounds = { x: 100, y: 100, width: 1400, height: 900 };
    expect(clampBoundsToDisplays(saved, [])).toBeNull();
  });
});

describe('loadWindowBounds / saveWindowBounds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'window-bounds-test-'));
  const file = join(dir, 'bounds.json');

  afterEach(() => {
    rmSync(file, { force: true });
  });

  it('returns null when the file does not exist', () => {
    expect(loadWindowBounds(file)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    writeFileSync(file, '{ not valid json', 'utf-8');
    expect(loadWindowBounds(file)).toBeNull();
  });

  it('round-trips bounds through save and load', () => {
    const bounds = { x: 10, y: 20, width: 1400, height: 900, isMaximized: false };
    saveWindowBounds(file, bounds);
    expect(existsSync(file)).toBe(true);
    expect(loadWindowBounds(file)).toEqual(bounds);
  });

  it('does not throw when saving to an unwritable path', () => {
    const badFile = join(dir, 'nonexistent-subdir', 'bounds.json');
    expect(() => saveWindowBounds(badFile, { x: 0, y: 0, width: 100, height: 100 })).not.toThrow();
  });
});
