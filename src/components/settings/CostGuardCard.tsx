import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';

export function CostGuardCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const crossEngineOn = state.crossEngineCfg.enabled;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>COST GUARD</div>

      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>ANTHROPIC API</div>
        <div style={valueStyle(colors)}>DISABLED · no SDK installed, no key-reachable path</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>MODEL CALLS BY AETHER</div>
        <div style={valueStyle(colors)}>NONE · zero call sites</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>CROSS-ENGINE VERIFY</div>
        <div style={valueStyle(colors)}>
          {crossEngineOn ? 'ON · ChatGPT subscription only, no API key path' : 'OFF'}
        </div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>AUTO HEADLINES</div>
        <div style={valueStyle(colors)}>computed locally, no API call</div>
      </div>

      <p style={hintStyle(colors)}>
        @anthropic-ai/{`sdk`} was removed from this app and its model-calling code paths deleted in
        Stage 13.5 — there is no key-reachable path left for Aether to call the Anthropic API on
        your behalf. Cross-engine verification (above) is the one real network exception, and it
        only ever runs when you enable it.
      </p>
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
function rowStyle(_colors: ColorPalette): CSSProperties {
  return { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, flexShrink: 0 };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary, textAlign: 'right' };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
