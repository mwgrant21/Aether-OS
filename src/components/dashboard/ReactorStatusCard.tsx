import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';
import { computeDashKpis, computeDashPulseMode, computeDashStatus } from './dashboardMath';

export function ReactorStatusCard() {
  const { state, dispatch } = useAetherStore();
  const statusC = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>REACTOR STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {computeDashStatus(state.alarmLevel)}
        </div>
      </div>

      <div style={{ flex: 'none', display: 'grid', placeItems: 'center', padding: '18px 0 6px' }}>
        <div style={{ position: 'relative', width: 120, height: 120, display: 'grid', placeItems: 'center' }}>
          <div style={ringOuterStyle} />
          <div style={ringInnerStyle} />
          <div style={glowDiscStyle} />
          <div style={coreDiscStyle} />
        </div>
      </div>
      <div style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {fmt(state.rate)} tok/min · {computeDashPulseMode(state.cfg)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => (
          <div key={dk.k} style={kpiTileStyle}>
            <div style={{ font: `600 9px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{dk.k}</div>
            <div style={{ font: `700 17px/1 ${fonts.mono}`, color: colors.textPrimary, marginTop: 7 }}>{dk.v}</div>
            <div style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 5 }}>{dk.s}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 14 }}>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={primaryActionStyle}>
          ⊕ SPAWN AGENT
        </span>
        <span onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={secondaryActionStyle}>
          ⊕ NEW PROJECT
        </span>
        <span
          onClick={() => {
            dispatch({ type: 'RUN_COMMAND', raw: 'sweep' });
            dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Memory' });
          }}
          style={secondaryActionStyle}
        >
          MEMORY SWEEP
        </span>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })} style={secondaryActionStyle}>
          OPEN TERMINAL
        </span>
        {/* Mission Composer modal is out of scope for this plan — button renders for visual
            fidelity but is intentionally not wired (see Global Constraints #1). */}
        <span style={{ ...composeActionStyle, cursor: 'default' }}>◇ COMPOSE MISSION</span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  gridRow: 'span 2',
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const ringOuterStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '2px dashed rgba(95,240,255,.3)',
  animation: 'spin 16s linear infinite',
};
const ringInnerStyle: CSSProperties = {
  position: 'absolute',
  inset: 16,
  borderRadius: '50%',
  border: '1px dashed rgba(120,235,255,.45)',
  animation: 'spinRev 10s linear infinite',
};
const glowDiscStyle: CSSProperties = {
  position: 'absolute',
  width: 76,
  height: 76,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(95,240,255,.28), transparent 66%)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const coreDiscStyle: CSSProperties = {
  position: 'relative',
  width: 54,
  height: 54,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 44% 38%, #fff, #7ef0ff 30%, #17b8d8 64%, #0a5f74 100%)',
  boxShadow: '0 0 22px rgba(95,240,255,.9), 0 0 52px rgba(80,220,255,.45)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const kpiTileStyle: CSSProperties = { padding: '11px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.18)', background: 'rgba(6,20,28,.5)' };
const primaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
  padding: '10px 0',
  borderRadius: 8,
  boxShadow: '0 0 14px rgba(95,240,255,.4)',
};
const secondaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#bff4ff',
  border: '1px solid rgba(95,220,255,.45)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.1)',
};
const composeActionStyle: CSSProperties = {
  gridColumn: 'span 2',
  textAlign: 'center',
  font: `600 12px/1 ${fonts.ui}`,
  letterSpacing: 2,
  color: colors.textPrimary,
  border: '1px solid rgba(95,220,255,.55)',
  padding: '11px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.18)',
  boxShadow: 'inset 0 0 18px rgba(95,240,255,.12)',
};
