import type { PanelType, Range } from './spec';

/** Shapes that cross the Boards IPC and MCP boundaries. Ids only, never paths. */
export type QueryErrorKind = 'guard' | 'missing-db' | 'busy' | 'timeout' | 'sql';

export interface PanelResult {
  panelId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  unpricedRows: number;
  error: string | null;
  errorKind: QueryErrorKind | 'columns' | 'cost' | null;
  refreshedAt: number;
}

export interface PanelSummary {
  id: string; title: string; type: PanelType; range: Range; sql: string;
  costBasis: 'exact' | 'estimated' | null; x: string | null; y: string[];
}
export interface BoardSummary { id: string; title: string; error: string | null; panels: PanelSummary[] }
export interface BoardsListing {
  collectorAvailable: boolean;
  boards: BoardSummary[];
  /** Path-free; set when the boards folder itself cannot be used. */
  error?: string;
}
export type RefreshResponse = { ok: true; panels: PanelResult[] } | { ok: false; error: string };
