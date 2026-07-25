import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function LiveOutputCard() {
  const { state } = useAetherStore();
  const logs = state.logs.slice(-8);
  const isActive = logs.length > 0;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <div style={titleStyle}>LIVE OUTPUT</div>
        {isActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyan }}>
            <span style={blinkDotStyle} />
            STREAMING
          </div>
        ) : (
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>IDLE</div>
        )}
      </div>
      <div style={logListStyle}>
        {logs.map((l, idx) => (
          <div key={idx} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: colors.textDim }}>[{l.t}]</span> <span style={{ color: l.c }}>{l.m}</span>
          </div>
        ))}
        {!isActive && <div style={emptyStyle}>no activity yet</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 'none',
  height: 152,
  padding: '12px 15px',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const blinkDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: colors.accentCyan,
  boxShadow: '0 0 8px rgba(126,240,255,.9)',
  animation: 'blink 1.2s step-end infinite',
};
const logListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  marginTop: 7,
  font: `400 10.5px/1.7 ${fonts.mono}`,
};
const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
