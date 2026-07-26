import { readFileSync, writeFileSync } from 'fs';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_INTERSECTION_PX = 100;

function intersectionArea(a: Bounds, b: Rect): { width: number; height: number } {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { width, height };
}

/**
 * Validates saved window bounds against the current display layout.
 * Returns null (caller should fall back to defaults) unless at least
 * ~100x100px of the saved bounds intersects some display. Oversized
 * bounds are clamped to fit the largest display.
 */
export function clampBoundsToDisplays(saved: Bounds | null, displays: Rect[]): Bounds | null {
  if (!saved || displays.length === 0) return null;

  const onScreen = displays.some((display) => {
    const { width, height } = intersectionArea(saved, display);
    return width >= MIN_INTERSECTION_PX && height >= MIN_INTERSECTION_PX;
  });
  if (!onScreen) return null;

  const largest = displays.reduce((biggest, d) =>
    d.width * d.height > biggest.width * biggest.height ? d : biggest
  );

  const width = Math.min(saved.width, largest.width);
  const height = Math.min(saved.height, largest.height);

  return { x: saved.x, y: saved.y, width, height };
}

export function loadWindowBounds(file: string): (Bounds & { isMaximized?: boolean }) | null {
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveWindowBounds(file: string, bounds: Bounds & { isMaximized?: boolean }): void {
  try {
    writeFileSync(file, JSON.stringify(bounds), 'utf-8');
  } catch (err) {
    console.warn('Failed to save window bounds:', err);
  }
}
