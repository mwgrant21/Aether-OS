// Modeled on ModelPolicyCard.tsx's button-row pattern. Governs the roster's
// voice-pack narration line (AgentRosterCard) only -- unrelated to Chat's
// densityLevel dial, which governs transcript summarization, not narration.
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { NarrationVerbosity } from '../../shared/narrationVerbosity';

const LEVELS: NarrationVerbosity[] = ['full', 'terse', 'silent'];

export function NarrationVerbosityCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const level = state.cfg.narrationVerbosity;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>NARRATION</div>
      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        {LEVELS.map((l) => (
          <Button
            key={l}
            onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { narrationVerbosity: l } })}
            style={levelButtonStyle(colors, l === level)}
          >
            {l.toUpperCase()}
          </Button>
        ))}
      </div>
      <div style={hintStyle(colors)}>
        Controls the agent roster's voice-pack narration line. At severity 3+, narration always renders regardless of this setting.
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
function levelButtonStyle(colors: ColorPalette, active: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: active ? '#04202b' : colors.textMuted,
    background: active ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: active ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: active ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `500 11px/1.4 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
