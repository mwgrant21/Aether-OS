import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { fmtElapsed } from '../../utils/format';

export function ActiveAgentsCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flex: 'none' }}>
        <div style={titleStyle(colors)}>ACTIVE AGENTS</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
        {state.realAgents.map((a) => (
          <div key={a.toolUseId} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <span style={avatarStyle(colors)}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textPrimary }}>{a.subagentType}</span>
                <span style={{ font: `700 12px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
              </div>
              <div style={taskStyle(colors)}>{a.description}</div>
            </div>
          </div>
        ))}
        {state.realAgents.length === 0 && <div style={emptyStyle(colors)}>no agents currently running</div>}
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    padding: 14,
    background: 'rgba(10,22,26,0.55)',
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: 10,
  };
}

function titleStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `700 11px/1 ${fonts.ui}`,
    letterSpacing: 1.2,
    color: colors.textMuted,
  };
}

function avatarStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    width: 28,
    height: 28,
    borderRadius: 8,
    display: 'grid',
    placeItems: 'center',
    font: `700 11px/1 ${fonts.mono}`,
    color: colors.accentCyanSoft,
    background: 'rgba(127,216,239,0.12)',
    border: `1px solid ${colors.accentCyanSoft}`,
  };
}

function taskStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `500 11px/1.3 ${fonts.ui}`,
    color: colors.textDim,
    marginTop: 2,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

function emptyStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `500 12px/1.4 ${fonts.ui}`,
    color: colors.textDim,
    padding: '8px 2px',
  };
}
