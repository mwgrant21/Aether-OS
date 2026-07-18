import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function ActiveAgentsDigest() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' })} style={viewAllStyle}>
          VIEW ALL →
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.agents.map((a) => (
          <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={avatarStyle(a.hue)}>{a.i}</span>
            <span style={nameStyle}>{a.name}</span>
            <span style={trackStyle}>
              <span style={{ display: 'block', height: '100%', width: `${Math.round(a.pct)}%`, background: a.hue, boxShadow: `0 0 8px ${a.hue}` }} />
            </span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: a.hue, width: 32, textAlign: 'right' }}>{Math.round(a.pct)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 7,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
const nameStyle: CSSProperties = { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const trackStyle: CSSProperties = { flex: 'none', width: 70, height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden' };
