import type { PanelResult } from '../../shared/dashboards/types';

export type ShownPanel = PanelResult & { staleBusy: boolean };
export const AUTO_REFRESH = { off: 0, '60s': 60_000, '5m': 300_000 } as const;
export type AutoRefresh = keyof typeof AUTO_REFRESH;

/** A busy panel keeps its last good result (flagged) instead of blanking while the collector writes, but only for the same definition. */
export function mergeRefresh(prev: Record<string, ShownPanel>, next: PanelResult[]): Record<string, ShownPanel> {
  const out: Record<string, ShownPanel> = {};
  for (const r of next) {
    const before = prev[r.panelId];
    out[r.panelId] = r.errorKind === 'busy' && before && before.error === null && before.definition === r.definition
      ? { ...before, staleBusy: true }
      : { ...r, staleBusy: false };
  }
  return out;
}
