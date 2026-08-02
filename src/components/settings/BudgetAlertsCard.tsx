import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { playYellowAlert } from '../../shared/alertSounds';

export function BudgetAlertsCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>BUDGET &amp; ALERTS</div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle(colors)}>MONTHLY CAP</div>
          <span style={valueStyle(colors)}>{cfg.capM.toFixed(1)}M tokens</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={cfg.capM}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { capM: Number(e.target.value) } })}
          style={sliderStyle(colors)}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle(colors)}>ALARM THRESHOLD</div>
          <span style={valueStyle(colors)}>{cfg.alarm}K tok/min</span>
        </div>
        <input
          type="range"
          min={50}
          max={200}
          step={10}
          value={cfg.alarm}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { alarm: Number(e.target.value) } })}
          style={sliderStyle(colors)}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>AUTO-THROTTLE</div>
        <Button onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoThrottle: !cfg.autoThrottle } })} style={toggleStyle(colors, cfg.autoThrottle)}>
          {cfg.autoThrottle ? 'ON' : 'OFF'}
        </Button>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>SOUND</div>
        <Button onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })} style={toggleStyle(colors, cfg.sound)}>
          {cfg.sound ? 'ON' : 'OFF'}
        </Button>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <Button onClick={() => playYellowAlert()} style={toggleStyle(colors, false)} title="Play the yellow-alert chirp to preview it">
          TEST SOUND
        </Button>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>AUTO-CREATE DISPATCH CHANNELS</div>
        <Button
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoCreateDispatchChannels: !cfg.autoCreateDispatchChannels } })}
          style={toggleStyle(colors, cfg.autoCreateDispatchChannels)}
        >
          {cfg.autoCreateDispatchChannels ? 'ON' : 'OFF'}
        </Button>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 11px/1 ${fonts.mono}`, color: colors.textBody };
}
function sliderStyle(colors: ColorPalette): CSSProperties {
  return { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
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
