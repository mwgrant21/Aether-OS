import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { formatValue } from './formatValue';

export function StatPanel({ rows, y }: { rows: Record<string, unknown>[]; y: string[] }) {
  const colors = useColors();
  const column = y[0];
  return (
    <div>
      <div style={{ fontFamily: fonts.mono, fontSize: 32, color: colors.textPrimary }}>{formatValue(column, rows[0]?.[column] ?? null)}</div>
      {rows.length > 1 && <div style={{ color: colors.textMuted, fontSize: 11 }}>first of {rows.length} rows</div>}
    </div>
  );
}
