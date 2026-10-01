import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';

export function CostGuardCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const crossEngineOn = state.crossEngineCfg.enabled;
  const memoryExtractionOn = state.memoryExtractionEnabled;

  return (
    <div style={cardStyle(colors)}>
      <h2 style={{ ...titleStyle(colors), margin: 0 }}>COST GUARD</h2>

      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>ANTHROPIC API</div>
        <div style={valueStyle(colors)}>DISABLED · no SDK installed, no key-reachable path</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>DIRECT ANTHROPIC CALLS</div>
        <div style={valueStyle(colors)}>NONE · no SDK or HTTP call sites</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>MEMORY EXTRACTION</div>
        <div style={valueStyle(colors)}>
          {memoryExtractionOn ? 'ON · dispatch result text sent to your Claude account via the claude CLI' : 'OFF'}
        </div>
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
        The Anthropic SDK dependency was removed from this app in Stage 13.5 — there is no
        key-reachable path left for Aether to call the Anthropic API directly. Opt-in
        memory extraction is the one background, Aether-initiated Claude model call: when ON, the
        collector sends dispatch result text to your Claude account through the claude CLI (only
        ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are removed from its
        environment; otherwise it uses Claude Code's own setup). Cross-engine
        verification and opted-in Claude–Codex consultations use external clients and your
        subscriptions. Communication starts require an allowance;
        enabling its preference alone does not make a consultation.
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
  return { font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, flexShrink: 0 };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary, textAlign: 'right' };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
