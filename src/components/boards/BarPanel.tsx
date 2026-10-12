import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { niceMax, seriesFrom } from './chartMath';
import { formatValue } from './formatValue';

export function BarPanel({ rows, x, y }: { rows: Record<string, unknown>[]; x: string; y: string[] }) {
  const colors = useColors();
  const { labels, series } = seriesFrom(rows, x, y);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  return (
    <div style={{ display: 'grid', gap: 4, fontFamily: fonts.mono, fontSize: 11 }}>
      {labels.map((label, i) => (
        <div key={`${label}-${i}`} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', alignItems: 'center', gap: 8 }}>
          <span title={label} style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <div style={{ display: 'grid', gap: 2 }}>
            {series.map((s, j) => {
              const v = s.values[i];
              return <div key={s.column} style={{ height: 8, width: v === null ? 0 : `${(Math.max(0, v) / max) * 100}%`, background: colors.agentHues[j % colors.agentHues.length] }} />;
            })}
          </div>
          <span style={{ color: colors.textBody, textAlign: 'right' }}>{series.map((s) => formatValue(s.column, s.values[i])).join(' / ')}</span>
        </div>
      ))}
    </div>
  );
}
