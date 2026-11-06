// Pure edge auto-scroll for dragging a selection near the top/bottom of the page (no DOM: timers
// are injectable). The zone and speed numbers are untuned guesses; tune them after a device test.
export const EDGE_ZONE_PX = 48;
export const EDGE_MAX_PX_PER_TICK = 28;
export const EDGE_TICK_MS = 16;

// Signed px to scroll per tick for a held point at y inside a viewport spanning top..bottom:
// negative (up) in the top zone, positive in the bottom zone, 0 between. The magnitude ramps
// linearly with depth into the zone and saturates at max (also beyond the edge). 0 for unusable
// input or a viewport too small for two zones.
export function edgeDelta({ y, top, bottom, zone = EDGE_ZONE_PX, max = EDGE_MAX_PX_PER_TICK }) {
  for (const v of [y, top, bottom, zone, max]) if (!Number.isFinite(v)) return 0;
  if (bottom - top < 2 * zone) return 0;
  if (y < top + zone) return -max * Math.min(1, (top + zone - y) / zone);
  if (y > bottom - zone) return max * Math.min(1, (y - (bottom - zone)) / zone);
  return 0;
}

// Repeating driver. start() arms one timer (idempotent); each tick scrolls by edgeDelta of the
// current point and idles (stays armed) outside the zones. stop() clears it and is safe twice.
export function createAutoScroll({
  setTimer = setInterval,
  clearTimer = clearInterval,
  tickMs = EDGE_TICK_MS,
  getPoint,
  getBounds,
  scrollBy,
}) {
  let timer = null;
  const tick = () => {
    if (timer === null) return;
    const p = getPoint();
    if (!p) return;
    const b = getBounds();
    const d = edgeDelta({ y: p.y, top: b.top, bottom: b.bottom });
    if (d !== 0) scrollBy(d);
  };
  return {
    start() {
      if (timer === null) timer = setTimer(tick, tickMs);
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    running: () => timer !== null,
  };
}
