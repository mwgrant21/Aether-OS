import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { formatValue } from './formatValue';

export function TablePanel({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const colors = useColors();
  const cell = { padding: '2px 8px', borderBottom: `1px solid ${colors.chromeBorder}`, textAlign: 'left' as const };
  return (
    <div style={{ maxHeight: 260, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: fonts.mono, fontSize: 11, color: colors.textBody }}>
        <thead><tr>{columns.map((c) => <th key={c} style={{ ...cell, color: colors.textSecondary }}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} style={cell}>{formatValue(c, r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
