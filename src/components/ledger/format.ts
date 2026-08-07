/**
 * Money and token formatting for the Ledger.
 *
 * Kept in one place so an exact figure and an estimate can never accidentally
 * be formatted identically: `usd()` and `approxUsd()` differ by the leading
 * `~`, and that tilde is the operator's only at-a-glance signal that a number
 * is inferred rather than measured.
 */

/** An exact dollar figure. No tilde -- this is exact to the pricing table. */
export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** An estimated dollar figure. Always carries the tilde. */
export function approxUsd(value: number): string {
  return `~$${value.toFixed(2)}`;
}

/**
 * Sub-cent figures round to $0.00, which reads as "free" when it usually means
 * "very small". Show a floor marker instead so a real-but-tiny cost is not
 * mistaken for nothing.
 */
export function usdPrecise(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01';
  return usd(value);
}

export function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/**
 * The one sentence explaining why every per-dispatch figure is approximate.
 * Deliberately not shortened to "estimated" -- the operator will want to know
 * *why* at exactly the moment the number matters.
 */
export const ESTIMATE_BASIS_TOOLTIP =
  'blended tier rate applied to a scalar token count; no input/output split is available from the completion notification';
