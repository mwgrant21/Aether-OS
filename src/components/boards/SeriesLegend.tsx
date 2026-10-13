import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';

/** Names each series' color; shown only when a chart has more than one series. */
export function SeriesLegend({ columns }: { columns: string[] }) {
  const colors = useColors();
  if (columns.length < 2) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary, marginBottom: 4 }}>
      {columns.map((c, i) => (
        <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden style={{ width: 10, height: 10, background: colors.agentHues[i % colors.agentHues.length] }} />
          {c}
        </span>
      ))}
    </div>
  );
}
