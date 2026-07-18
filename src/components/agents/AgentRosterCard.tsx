import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { agentStatusLabel } from './agentsMath';

export function AgentRosterCard({ selectedName }: { selectedName: string | null }) {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>AGENT ROSTER</div>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={spawnButtonStyle}>
          SPAWN +
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.agents.map((a) => {
          const on = a.name === selectedName;
          const status = agentStatusLabel(a);
          const statusC = status === 'PAUSED' ? colors.warn : colors.success;
          return (
            <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={rowStyle(on)}>
              <span style={avatarStyle(a.hue)}>{a.i}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={nameStyle}>{a.name}</span>
                  <span style={{ font: `700 11px/1 ${fonts.mono}`, color: a.hue }}>{Math.round(a.pct)}%</span>
                </div>
                <div style={trackStyle}>
                  <div style={{ height: '100%', width: `${Math.round(a.pct)}%`, background: a.hue, boxShadow: `0 0 8px ${a.hue}` }} />
                </div>
              </div>
              <span style={{ ...statusDotStyle, background: statusC, boxShadow: `0 0 6px ${statusC}` }} title={status} />
            </div>
          );
        })}
        {!state.agents.length && <div style={emptyStyle}>no active agents — spawn one to get started</div>}
      </div>

      <div style={idleHeaderStyle}>IDLE ({state.idleList.length})</div>
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxHeight: 140, overflow: 'auto' }}>
        {state.idleList.map((i) => (
          <div key={i.name} style={idleRowStyle}>
            <div style={{ minWidth: 0 }}>
              <div style={idleNameStyle}>{i.name}</div>
              <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 3 }}>last active {i.last}</div>
            </div>
            <span onClick={() => dispatch({ type: 'REACTIVATE_AGENT', name: i.name })} style={reactivateButtonStyle}>
              REACTIVATE
            </span>
          </div>
        ))}
        {!state.idleList.length && <div style={emptyStyle}>no idle agents</div>}
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
const spawnButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
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
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 30,
    height: 30,
    flex: 'none',
    borderRadius: 8,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 11px/1 ${fonts.mono}`,
    color: hue,
  };
}
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 5 };
const statusDotStyle: CSSProperties = { width: 7, height: 7, borderRadius: '50%', flex: 'none' };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
const idleHeaderStyle: CSSProperties = {
  flex: 'none',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 3,
  color: colors.textDim,
  marginTop: 16,
  paddingTop: 12,
  borderTop: `1px solid ${colors.chromeBorder}`,
};
const idleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '8px 9px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.16)',
  background: 'rgba(6,20,28,.5)',
};
const idleNameStyle: CSSProperties = {
  font: `600 12px/1 ${fonts.ui}`,
  color: colors.textSecondary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const reactivateButtonStyle: CSSProperties = {
  flex: 'none',
  cursor: 'pointer',
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
