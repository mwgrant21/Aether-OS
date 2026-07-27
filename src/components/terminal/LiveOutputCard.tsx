import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';

export function LiveOutputCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const logs = state.logs.slice(-8);
  const isActive = logs.length > 0;
  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <div style={titleStyle(colors)}>LIVE OUTPUT</div>
        {isActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyan }}>
            <span style={blinkDotStyle(colors)} />
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
        {!isActive && <div style={emptyStyle(colors)}>no activity yet</div>}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    height: 152,
    padding: '12px 15px',
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function blinkDotStyle(colors: ColorPalette): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: colors.accentCyan,
    boxShadow: '0 0 8px rgba(126,240,255,.9)',
    animation: 'blink 1.2s step-end infinite',
  };
}
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
function emptyStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `500 12px/1.4 ${fonts.ui}`,
    color: colors.textDim,
    padding: '8px 2px',
  };
}
