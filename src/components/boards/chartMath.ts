import { formatLabel } from './formatValue';

export interface Series { column: string; values: (number | null)[] }

export function seriesFrom(rows: Record<string, unknown>[], x: string, ys: string[]): { labels: string[]; series: Series[] } {
  return {
    labels: rows.map((r) => formatLabel(r[x])),
    series: ys.map((column) => ({
      column,
      values: rows.map((r) => (typeof r[column] === 'number' && Number.isFinite(r[column]) ? (r[column] as number) : null)),
    })),
  };
}

export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/** Signed axis domain with a zero baseline; magnitudes rounded up with niceMax. Never lo === hi. */
export function niceDomain(values: number[]): { lo: number; hi: number } {
  const minV = Math.min(0, ...values);
  const maxV = Math.max(0, ...values);
  const lo = minV < 0 ? -niceMax(-minV) : 0;
  const hi = maxV > 0 ? niceMax(maxV) : lo < 0 ? 0 : 1;
  return { lo, hi };
}

export const pointX = (i: number, n: number, width: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
export const pointY = (v: number, height: number, lo: number, hi: number) => height - ((v - lo) / (hi - lo)) * height;

/** One SVG path per run of non-null values: a null breaks the line, so a no-data day is a visible gap. */
export function linePaths(values: (number | null)[], width: number, height: number, lo: number, hi: number): string[] {
  const paths: string[] = [];
  let current = '';
  values.forEach((v, i) => {
    if (v === null) { if (current) paths.push(current); current = ''; return; }
    current += `${current ? ' L' : 'M'}${pointX(i, values.length, width).toFixed(1)} ${pointY(v, height, lo, hi).toFixed(1)}`;
  });
  if (current) paths.push(current);
  return paths;
}
