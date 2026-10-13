import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { niceDomain, seriesFrom } from './chartMath';
import { formatValue } from './formatValue';
import { SeriesLegend } from './SeriesLegend';

export function BarPanel({ rows, x, y }: { rows: Record<string, unknown>[]; x: string; y: string[] }) {
  const colors = useColors();
  const { labels, series } = seriesFrom(rows, x, y);
  const { lo, hi } = niceDomain(series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const span = hi - lo;
  return (
    <div style={{ display: 'grid', gap: 4, fontFamily: fonts.mono, fontSize: 11 }}>
      <SeriesLegend columns={y} />
      {labels.map((label, i) => (
        <div key={`${label}-${i}`} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', alignItems: 'center', gap: 8 }}>
          <span title={label} style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <div style={{ display: 'grid', gap: 2 }}>
            {series.map((s, j) => {
              const v = s.values[i];
              return <div key={s.column} title={`${s.column}: ${formatValue(s.column, v)}`} style={{ height: 8, marginLeft: v === null ? 0 : `${((Math.min(v, 0) - lo) / span) * 100}%`, width: v === null ? 0 : `${(Math.abs(v) / span) * 100}%`, background: colors.agentHues[j % colors.agentHues.length] }} />;
            })}
          </div>
          <span style={{ color: colors.textBody, textAlign: 'right' }}>{series.map((s) => formatValue(s.column, s.values[i])).join(' / ')}</span>
        </div>
      ))}
    </div>
  );
}
