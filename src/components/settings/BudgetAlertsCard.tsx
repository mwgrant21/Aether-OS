import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function BudgetAlertsCard() {
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>BUDGET &amp; ALERTS</div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>MONTHLY CAP</div>
          <span style={valueStyle}>{cfg.capM.toFixed(1)}M tokens</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={cfg.capM}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { capM: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>ALARM THRESHOLD</div>
          <span style={valueStyle}>{cfg.alarm}K tok/min</span>
        </div>
        <input
          type="range"
          min={50}
          max={200}
          step={10}
          value={cfg.alarm}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { alarm: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>AUTO-THROTTLE</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoThrottle: !cfg.autoThrottle } })} style={toggleStyle(cfg.autoThrottle)}>
          {cfg.autoThrottle ? 'ON' : 'OFF'}
        </span>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>SOUND</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })} style={toggleStyle(cfg.sound)}>
          {cfg.sound ? 'ON' : 'OFF'}
        </span>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>AUTO-CREATE DISPATCH CHANNELS</div>
        <span
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoCreateDispatchChannels: !cfg.autoCreateDispatchChannels } })}
          style={toggleStyle(cfg.autoCreateDispatchChannels)}
        >
          {cfg.autoCreateDispatchChannels ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const labelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const valueStyle: CSSProperties = { font: `700 11px/1 ${fonts.mono}`, color: colors.textBody };
const sliderStyle: CSSProperties = { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
function toggleStyle(on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
