import { useId, type CSSProperties } from 'react';
import { fonts, glows, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { DESKTOP_APP_REASON, hasDesktopApp } from './readinessMath';

/**
 * The Dashboard's one primary action, shared by the reactor card and
 * READINESS. In browser mode there is no pty to open, so it stays in place,
 * aria-disabled (still focusable, so a screen reader reaches it and hears
 * why), with the Desktop-app reason directly beneath it. Nothing about it
 * reads as an error.
 */
export function OpenTerminalButton({ live }: { live: boolean }) {
  const colors = useColors();
  const { dispatch } = useAetherStore();
  const reasonId = useId();
  const desktop = hasDesktopApp();
  return (
    <div style={wrapStyle}>
      <Button
        onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })}
        aria-disabled={desktop ? undefined : true}
        aria-describedby={desktop ? undefined : reasonId}
        style={desktop ? primaryActionStyle(colors, live) : disabledActionStyle(colors)}
        hoverStyle={desktop ? primaryActionHoverStyle : NO_HOVER}
      >
        <span aria-hidden="true">⊕</span> OPEN TERMINAL
      </Button>
      {!desktop && (
        <p id={reasonId} style={reasonStyle(colors)}>
          {DESKTOP_APP_REASON}
        </p>
      )}
    </div>
  );
}

const wrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 14 };

// Primary stays the filled cyan switch; per Glow-Is-State it only glows when
// a session is live (the terminal it opens is doing work) or when hovered /
// keyboard-focused (Button applies hoverStyle for both). Flat at STANDBY rest.
function primaryActionStyle(colors: ColorPalette, live: boolean): CSSProperties {
  return {
    textAlign: 'center',
    cursor: 'pointer',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: colors.inkOnCyan,
    background: `linear-gradient(180deg, ${colors.accentCyan}, ${colors.accentCyanDeep})`,
    padding: '10px 0',
    borderRadius: 8,
    boxShadow: live ? glows.active : undefined,
  };
}
// DESIGN.md Buttons > Hover: brighter, a stronger glow, a 1px lift.
const primaryActionHoverStyle: CSSProperties = {
  filter: 'brightness(1.1)',
  boxShadow: glows.primaryHover,
  transform: 'translateY(-1px)',
};
// DESIGN.md button-primary-disabled: inset background, Text Dim label, no glow.
function disabledActionStyle(colors: ColorPalette): CSSProperties {
  return {
    textAlign: 'center',
    cursor: 'default',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: colors.textDim,
    background: colors.panelInset,
    border: `1px solid ${colors.chromeBorder}`,
    padding: '10px 0',
    borderRadius: 8,
  };
}
// An empty hover style: a disabled control doesn't light up under the pointer.
// (Button's default hover would otherwise brighten it.) Keyboard focus still
// gets the ring.
const NO_HOVER: CSSProperties = {};
function reasonStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted };
}
