import { approxUsd, usdPrecise } from '../ledger/format';

/** "No data" and "$0.00" are different answers (Stage 15); null always renders as this. */
export const NO_DATA = 'no data';

export function formatValue(column: string, value: unknown): string {
  if (value === null || value === undefined) return NO_DATA;
  if (typeof value !== 'number') return String(value);
  if (column === 'usd') return usdPrecise(value);
  if (column === 'usdApprox') return value > 0 && value < 0.005 ? '~<$0.01' : approxUsd(value);
  if (column.endsWith('_rate')) return `${(value * 100).toFixed(1)}%`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatLabel(value: unknown): string {
  return value === null || value === undefined ? '(none)' : String(value);
}
