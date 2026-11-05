// Night label and window maths. Local time via Date(y, m, d, h, mi); no timezone library.
export const GRACE_MS = 12 * 3600 * 1000;

const pad = (n) => String(n).padStart(2, '0');

export function newNightId(nowMs) {
  const d = new Date(nowMs);
  return `n${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function at(base, dayOffset, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m).getTime();
}

// The window containing nowMs, else the next one. end <= start crosses midnight;
// nowMs === endMs counts as over.
export function windowFor(nowMs, { start, end }) {
  const base = new Date(nowMs);
  const crosses = at(base, 0, end) <= at(base, 0, start);
  // Candidate starts: yesterday, today, tomorrow (in order); first whose end is after now.
  for (const off of [-1, 0, 1]) {
    const startMs = at(base, off, start);
    const endMs = at(base, off + (crosses ? 1 : 0), end);
    if (nowMs < endMs) return { startMs, endMs };
  }
  /* c8 ignore next */
  throw new Error('windowFor: no window found');
}

export function isNightCurrent(nowMs, targetWindowStartMs, graceMs = GRACE_MS) {
  return nowMs <= targetWindowStartMs + graceMs;
}
