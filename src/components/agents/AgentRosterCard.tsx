import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';

export function AgentRosterCard({ selectedToolUseId }: { selectedToolUseId: string | null }) {
  const { state, dispatch } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>AGENT ROSTER</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.realAgents.map((a) => {
          const on = a.toolUseId === selectedToolUseId;
          return (
            <div key={a.toolUseId} onClick={() => dispatch({ type: 'SELECT_REAL_AGENT', toolUseId: a.toolUseId })} style={rowStyle(on)}>
              <span style={avatarStyle}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={nameStyle}>{a.subagentType}</span>
                  <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
                </div>
                <div style={descStyle}>{a.description}</div>
              </div>
            </div>
          );
        })}
        {!state.realAgents.length && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: 300,
  flex: 'none',
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
function rowStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
const avatarStyle: CSSProperties = {
  width: 30,
  height: 30,
  flex: 'none',
  borderRadius: 8,
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 11px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const descStyle: CSSProperties = {
  font: `400 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  marginTop: 3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
