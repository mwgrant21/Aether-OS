import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function ActiveAgentsCard() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flex: 'none' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
        <div onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={spawnButtonStyle}>
          SPAWN +
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
        {state.agents.map((a) => (
          <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer' }}>
            <span style={avatarStyle(a.hue)}>{a.i}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textPrimary }}>{a.name}</span>
                <span style={{ font: `700 12px/1 ${fonts.mono}`, color: a.hue }}>{Math.round(a.pct)}%</span>
              </div>
              <div style={taskStyle}>{a.task}</div>
              <div style={trackStyle}>
                <div style={fillStyle(a.pct, a.hue)} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const spawnButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 34,
    height: 34,
    flex: 'none',
    borderRadius: 8,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 12px/1 ${fonts.mono}`,
    color: hue,
  };
}
const taskStyle: CSSProperties = {
  font: `400 11px/1 ${fonts.ui}`,
  color: colors.textMuted,
  margin: '4px 0 6px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden' };
function fillStyle(pct: number, hue: string): CSSProperties {
  return { height: '100%', width: `${pct}%`, background: hue, boxShadow: `0 0 10px ${hue}`, transition: 'width .5s ease' };
}
