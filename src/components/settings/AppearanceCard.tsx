import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { THEME_NAMES, RENDERER_WORDS } from '../terminal/commands';
import { rendererKeyToWord } from './settingsMath';

const THEME_HEX: Record<string, string> = {
  cyan: '#7ef0ff',
  blue: '#5fa8ff',
  teal: '#5fffe0',
  violet: '#c58bff',
  amber: '#f5c66b',
  red: '#ff6b7a',
};

export function AppearanceCard() {
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;
  const activeRendererWord = rendererKeyToWord(cfg.renderer);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>APPEARANCE</div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>THEME</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {THEME_NAMES.map((name) => (
            <span
              key={name}
              title={name}
              onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `theme ${name}` })}
              style={swatchStyle(THEME_HEX[name], cfg.theme === name)}
            />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>RENDERER</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {RENDERER_WORDS.map((word) => (
            <span key={word} onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `renderer ${word}` })} style={toggleStyle(activeRendererWord === word)}>
              {word}
            </span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>REACTOR PULSE</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['live', 'ambient'] as const).map((mode) => (
            <span key={mode} onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { pulseMode: mode } })} style={toggleStyle(cfg.pulseMode === mode)}>
              {mode}
            </span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>CORE GLOW INTENSITY</div>
          <span style={valueStyle}>{cfg.glow}</span>
        </div>
        <input
          type="range"
          min={0}
          max={140}
          step={10}
          value={cfg.glow}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { glow: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>GLOW EFFECTS</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { glowFx: !cfg.glowFx } })} style={pillToggleStyle(cfg.glowFx)}>
          {cfg.glowFx ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const labelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const valueStyle: CSSProperties = { font: `700 11px/1 ${fonts.mono}`, color: colors.textBody };
function swatchStyle(hex: string, on: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: '50%',
    cursor: 'pointer',
    background: hex,
    boxShadow: on ? `0 0 0 2px ${colors.bgBase}, 0 0 0 4px ${hex}` : `0 0 8px ${hex}`,
  };
}
function toggleStyle(on: boolean): CSSProperties {
  return {
    flex: 1,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '7px 0',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function pillToggleStyle(on: boolean): CSSProperties {
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
const sliderStyle: CSSProperties = { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
