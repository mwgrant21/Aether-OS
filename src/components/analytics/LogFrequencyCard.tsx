import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { computeLogFrequency } from './analyticsMath';

export function LogFrequencyCard() {
  const { state } = useAetherStore();
  const rows = computeLogFrequency(state.logs);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>ALERT / LOG FREQUENCY</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', flex: 'none', background: r.color, boxShadow: `0 0 8px ${r.color}` }} />
            <span style={{ flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary }}>{r.label}</span>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: r.color }}>{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
