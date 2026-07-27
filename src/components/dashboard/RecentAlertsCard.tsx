import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';

export function RecentAlertsCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const alerts = state.notifs.slice(0, 8);
  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>RECENT ALERTS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {alerts.map((nf, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 9, font: `400 10.5px/1.5 ${fonts.mono}` }}>
            <span style={{ color: colors.textDim, flex: 'none' }}>{nf.t}</span>
            <span style={{ color: nf.c }}>{nf.m}</span>
          </div>
        ))}
        {!alerts.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no alerts — reactor calm</div>}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
