export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function short(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return 'n/a';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function spark(hist: number[]): string {
  const max = Math.max(...hist);
  const min = Math.min(...hist);
  const span = Math.max(1, max - min);
  return hist
    .map((v, i) => {
      const x = (i / (hist.length - 1)) * 62;
      const y = 20 - ((v - min) / span) * 16 - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function nowLong(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function nowShort(): string {
  return nowLong().slice(0, 5);
}

export function resolveOperatorName(name: string): string {
  return name.trim() || 'Operator';
}
