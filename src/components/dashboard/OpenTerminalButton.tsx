import { useId, type CSSProperties } from 'react';
import { fonts, glows, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { DESKTOP_APP_REASON, hasDesktopApp } from './readinessMath';

export type OpenTerminalVariant = 'primary' | 'secondary';

/**
 * The one OPEN TERMINAL in the app; openTerminalLiteral.test.ts fails if any
 * other file carries a string/JSX-text literal matching the label, allowing
 * decoration (icons, arrows) on either side -- see that file's isLabel for
 * exactly what counts as a match, and its header comment for what a plain
 * literal scan cannot catch (a JSX-split label, a template with `${}`,
 * concatenation). `primary` is the Dashboard's action under READINESS;
 * `secondary` (DESIGN.md Buttons > Secondary) is for empty states such as
 * the Agents roster. In browser mode there is no pty to open, so either
 * variant stays in place, aria-disabled (still focusable, so a screen
 * reader reaches it and hears why), with the Desktop-app reason directly
 * beneath it. Nothing about it reads as an error.
 */
export function OpenTerminalButton({ live = false, variant = 'primary' }: { live?: boolean; variant?: OpenTerminalVariant }) {
  const colors = useColors();
  const { dispatch } = useAetherStore();
  const reasonId = useId();
  const desktop = hasDesktopApp();
  const secondary = variant === 'secondary';
  const style = !desktop ? disabledActionStyle(colors, variant) : secondary ? secondaryActionStyle(colors) : primaryActionStyle(colors, live);
  const hoverStyle = !desktop ? NO_HOVER : secondary ? secondaryActionHoverStyle(colors) : primaryActionHoverStyle;
  return (
    <div style={secondary ? secondaryWrapStyle : primaryWrapStyle}>
      <Button
        onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })}
        aria-disabled={desktop ? undefined : true}
        aria-describedby={desktop ? undefined : reasonId}
        style={style}
        hoverStyle={hoverStyle}
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

const primaryWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 14 };
// Secondary sits inside an EmptyState that already spaces it; it keeps its own width.
const secondaryWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 };

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
// DESIGN.md Buttons > Secondary: inset surface, Reactor Cyan label, Active
// Edge border; hover takes a solid cyan edge and the outer + inner glow.
function secondaryActionStyle(colors: ColorPalette): CSSProperties {
  return {
    cursor: 'pointer',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 2,
    color: colors.accentCyan,
    background: colors.panelInset,
    border: `1px solid ${colors.activeBorder}`,
    borderRadius: radii.tile,
    padding: '7px 12px',
  };
}
function secondaryActionHoverStyle(colors: ColorPalette): CSSProperties {
  return { border: `1px solid ${colors.accentCyan}`, boxShadow: `${glows.active}, ${glows.innerCharge}` };
}
// DESIGN.md button-primary-disabled: inset background, Text Dim label, no glow.
// The secondary shape keeps its own padding and radius so it does not jump.
function disabledActionStyle(colors: ColorPalette, variant: OpenTerminalVariant): CSSProperties {
  const base: CSSProperties = {
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
  return variant === 'secondary' ? { ...base, letterSpacing: 2, padding: '7px 12px', borderRadius: radii.tile } : base;
}
// An empty hover style: a disabled control doesn't light up under the pointer.
// (Button's default hover would otherwise brighten it.) Keyboard focus still
// gets the ring.
const NO_HOVER: CSSProperties = {};
function reasonStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted };
}
