import { useEffect, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { OP_MODES, opModeOnSkin } from '../shared/opModes';

export const SETTINGS_OP_MODE_GROUP_LABEL = 'Operating mode (synced with top bar)';

export function OperatingModeCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { autoHeadlines } = state.cfg;

  // Push the persisted preference to main on every mount (covers app restart,
  // where main.ts always starts with its own default until told otherwise)
  // and on every toggle.
  useEffect(() => {
    window.aetherElectron?.agents.setAutoHeadlines(autoHeadlines);
  }, [autoHeadlines]);

  return (
    <div style={cardStyle(colors)}>
      <h2 style={{ ...titleStyle(colors), margin: 0 }}>OPERATING MODE</h2>
      {/* Same pattern as the TopBar pills: toggle buttons in a labelled group,
          each its own Tab stop, glyph hidden so the name is just the mode.
          Both groups set the same cfg.opMode (SET_OP_MODE), so this one is not
          a separate "default"; its name says it mirrors the top bar so a
          screen reader never hears two identical "Operating mode" groups. */}
      <div role="group" aria-label={SETTINGS_OP_MODE_GROUP_LABEL} style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {OP_MODES.map((om) => {
          const on = state.cfg.opMode === om.key;
          return (
            <Button
              key={om.key}
              title={om.meaning}
              onClick={() => dispatch({ type: 'SET_OP_MODE', mode: om.key })}
              style={opModeStyle(colors, on, om.key)}
              aria-pressed={on}
            >
              <span aria-hidden="true">{om.glyph}</span> {om.label}
            </Button>
          );
        })}
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>AUTO HEADLINES</div>
        <Button
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoHeadlines: !autoHeadlines } })}
          style={toggleStyle(colors, autoHeadlines)}
        >
          {autoHeadlines ? 'ON' : 'OFF'}
        </Button>
      </div>
      <div style={hintStyle(colors)}>
        Periodically updates each active agent's status line with a snippet of its current
        work, computed locally with no API call and no cost. Turn off to keep the roster on
        each dispatch's static description instead.
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle(colors)}>PERMISSION AUTO-ALLOW</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['NONE', 'LOW', 'LOW_MED'] as const).map((level) => (
            <Button
              key={level}
              onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { permissionAutoAllow: level } })}
              style={toggleStyle(colors, state.cfg.permissionAutoAllow === level)}
            >
              {level === 'LOW_MED' ? 'LOW+MED' : level}
            </Button>
          ))}
        </div>
      </div>
      <div style={hintStyle(colors)}>
        Real permission requests at or below this risk level are allowed automatically, with no
        prompt. Requests above it (destructive Bash at NONE/LOW/LOW_MED, or everything at NONE)
        still require a manual Approve/Deny.
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
function opModeStyle(colors: ColorPalette, on: boolean, key: OpMode): CSSProperties {
  return {
    flex: 1,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '10px 0',
    borderRadius: 8,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    ...(on ? opModeOnSkin(colors, key) : { color: colors.textMuted, background: 'rgba(10,32,43,.6)' }),
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `500 11px/1.4 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
