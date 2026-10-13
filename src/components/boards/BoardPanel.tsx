import { useState, type ReactElement } from 'react';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import type { PanelSummary } from '../../shared/dashboards/types';
import type { ShownPanel } from './boardsState';
import { NO_DATA } from './formatValue';
import { LinePanel } from './LinePanel';
import { BarPanel } from './BarPanel';
import { StatPanel } from './StatPanel';
import { TablePanel } from './TablePanel';

export function BoardPanel({ panel, result, refreshing }: { panel: PanelSummary; result: ShownPanel | undefined; refreshing: boolean }) {
  const colors = useColors();
  const [showSql, setShowSql] = useState(false);
  const notes: string[] = [];
  if (result?.staleBusy) notes.push('collector busy: showing last good data, retry');
  if (result?.truncated) notes.push(`truncated at ${result.rows.length}`);
  if (result && result.unpricedRows > 0) notes.push(`${result.unpricedRows} rows unpriced (no model)`);
  if (panel.costBasis === 'estimated') notes.push('est. (blended tier rate)');
  if (panel.costBasis === 'exact') notes.push('API rate (not paid)');

  let body: ReactElement;
  if (!result) body = <div style={{ color: colors.textMuted }}>{refreshing ? 'Loading…' : 'Not refreshed yet.'}</div>;
  else if (result.error && !result.staleBusy) {
    body = <div role="alert" style={{ color: colors.danger, fontFamily: fonts.mono, fontSize: 11 }}>{result.errorKind === 'busy' ? 'Collector is busy, retry.' : result.error}</div>;
  } else if (result.rows.length === 0) body = <div style={{ color: colors.textMuted }}>{NO_DATA}</div>;
  else if (panel.type === 'line') body = <LinePanel rows={result.rows} x={panel.x ?? ''} y={panel.y} />;
  else if (panel.type === 'bar') body = <BarPanel rows={result.rows} x={panel.x ?? ''} y={panel.y} />;
  else if (panel.type === 'stat') body = <StatPanel rows={result.rows} y={panel.y} />;
  else body = <TablePanel columns={result.columns} rows={result.rows} />;

  return (
    <section aria-label={panel.title} style={{ background: colors.panelGradient, border: `1px solid ${colors.panelBorder}`, padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontFamily: fonts.ui, fontSize: 14, color: colors.textPrimary, letterSpacing: 1 }}>{panel.title}</h3>
        <Button aria-pressed={showSql} onClick={() => setShowSql((v) => !v)} style={{ fontSize: 11, color: colors.textSecondary, background: colors.panelInset, border: `1px solid ${colors.chipBorder}`, padding: '2px 8px' }}>
          {showSql ? 'Hide query' : 'Show query'}
        </Button>
      </header>
      {showSql && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary, background: colors.panelInset, padding: 8 }}>{panel.sql}</pre>}
      {body}
      {notes.length > 0 && <div style={{ color: colors.textMuted, fontSize: 11 }}>{notes.join(' · ')}</div>}
    </section>
  );
}
