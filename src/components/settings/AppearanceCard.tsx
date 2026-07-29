import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
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
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;
  const activeRendererWord = rendererKeyToWord(cfg.renderer);

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>APPEARANCE</div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle(colors)}>THEME</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {THEME_NAMES.map((name) => (
            <Button
              key={name}
              title={name}
              onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `theme ${name}` })}
              style={swatchStyle(colors, THEME_HEX[name], cfg.theme === name)}
            >
              {null}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle(colors)}>RENDERER</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {RENDERER_WORDS.map((word) => (
            <Button
              key={word}
              onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `renderer ${word}` })}
              style={toggleStyle(colors, activeRendererWord === word)}
            >
              {word}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle(colors)}>MODE</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['dark', 'light'] as const).map((mode) => (
            <Button
              key={mode}
              onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `thememode ${mode}` })}
              style={toggleStyle(colors, cfg.themeMode === mode)}
            >
              {mode}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle(colors)}>REACTOR PULSE</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['live', 'ambient'] as const).map((mode) => (
            <Button
              key={mode}
              onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { pulseMode: mode } })}
              style={toggleStyle(colors, cfg.pulseMode === mode)}
            >
              {mode}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle(colors)}>TRANSCRIPT DENSITY</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['normal', 'verbose', 'summary'] as const).map((level) => (
            <Button
              key={level}
              onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { densityLevel: level } })}
              style={toggleStyle(colors, cfg.densityLevel === level)}
            >
              {level}
            </Button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle(colors)}>CORE GLOW INTENSITY</div>
          <span style={valueStyle(colors)}>{cfg.glow}</span>
        </div>
        <input
          type="range"
          min={0}
          max={140}
          step={10}
          value={cfg.glow}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { glow: Number(e.target.value) } })}
          style={sliderStyle(colors)}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>GLOW EFFECTS</div>
        <Button
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { glowFx: !cfg.glowFx } })}
          style={pillToggleStyle(colors, cfg.glowFx)}
          title={cfg.glowFx ? 'Disable glow effects' : 'Enable glow effects'}
        >
          {cfg.glowFx ? 'ON' : 'OFF'}
        </Button>
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>REACTOR LEGEND</div>
        <Button
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { showReactorLegend: !cfg.showReactorLegend } })}
          style={pillToggleStyle(colors, cfg.showReactorLegend)}
          title={cfg.showReactorLegend ? 'Hide reactor legend' : 'Show reactor legend'}
        >
          {cfg.showReactorLegend ? 'ON' : 'OFF'}
        </Button>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
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
function swatchStyle(colors: ColorPalette, hex: string, on: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: '50%',
    cursor: 'pointer',
    background: hex,
    boxShadow: on ? `0 0 0 2px ${colors.bgBase}, 0 0 0 4px ${hex}` : `0 0 8px ${hex}`,
  };
}
function toggleBaseStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    textAlign: 'center',
    cursor: 'pointer',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    ...toggleBaseStyle(colors, on),
    flex: 1,
    padding: '7px 0',
    textTransform: 'uppercase',
  };
}
function pillToggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    ...toggleBaseStyle(colors, on),
    minWidth: 52,
    padding: '6px 12px',
  };
}
function sliderStyle(colors: ColorPalette): CSSProperties {
  return { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
}
