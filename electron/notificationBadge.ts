// Renders a small filled-circle RGBA bitmap for BrowserWindow.setOverlayIcon()
// -- a presence indicator, not an exact count (see plan's Global Constraints:
// rendering an accurate digit needs either a native `canvas` dependency or a
// hand-rolled bitmap font, out of proportion to this feature's value here).
// Pure pixel math, no dependency, no static asset file.
export function renderNotificationBadge(size: number): { buffer: Buffer; width: number; height: number } {
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const inside = dx * dx + dy * dy <= radius * radius;
      const idx = (y * size + x) * 4;
      if (inside) {
        buffer[idx] = 214; // R -- matches the existing amber/red alert palette family
        buffer[idx + 1] = 40; // G
        buffer[idx + 2] = 40; // B
        buffer[idx + 3] = 255; // A: opaque
      } else {
        buffer[idx + 3] = 0; // A: transparent
      }
    }
  }
  return { buffer, width: size, height: size };
}
