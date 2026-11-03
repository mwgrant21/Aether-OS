import type { CSSProperties } from 'react';
import type { EffortLevel, ReadoutState, TierId } from '../../shared/aetherChoice/types';
import {
  BAR_SLOTS,
  GLYPH_GAP_PX,
  GLOW,
  NEUTRALS,
  ROLE_COLORS,
  TIER_TABLE,
  UNFILLED_BAR_OPACITY,
} from '../../shared/aetherChoice/tiers';
import './aetherChoice.css';

export const PULSE_CLASS = 'aetherChoicePulse';
const PULSE_ANIMATION = `aetherChoicePulse ${GLOW.red.pulseSeconds}s ease-in-out infinite`;
const DISABLED_OPACITY = 0.5;
const QUEUED_OPACITY = 0.5;
const AMBER_GLOW = '0 0 10px rgba(255,180,84,.30)';
const RED_GLOW = '0 0 18px rgba(255,92,87,.85)';

export type ReadoutStyle = {
  color: string;
  boxShadow?: string;
  opacity: number;
  animation: string;
};

/** Style for a readout state. Pure; the red pulse itself lives in aetherChoice.css. */
export function readoutStyle(state: ReadoutState, opts: { reducedMotion: boolean }): ReadoutStyle {
  switch (state) {
    case 'steady':
      return { color: NEUTRALS.fg, opacity: 1, animation: 'none' };
    case 'queued':
    case 'queuedModel':
      return { color: NEUTRALS.dim, opacity: QUEUED_OPACITY, animation: 'none' };
    case 'applying':
    case 'unconfirmed':
      return { color: ROLE_COLORS.live, opacity: 1, animation: 'none' };
    case 'blocked':
      return { color: ROLE_COLORS.needsYou, boxShadow: AMBER_GLOW, opacity: 1, animation: 'none' };
    case 'notApplied':
      return {
        color: ROLE_COLORS.failed,
        boxShadow: RED_GLOW,
        opacity: 1,
        animation: opts.reducedMotion ? 'none' : PULSE_ANIMATION,
      };
  }
}

function Sparkle() {
  return (
    <svg data-glyph="sparkle" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 0 L6.2 3.8 L10 5 L6.2 6.2 L5 10 L3.8 6.2 L0 5 L3.8 3.8 Z" fill="currentColor" />
    </svg>
  );
}

function Bars({ filled }: { filled: number }) {
  return (
    <span className="aetherChoiceBars" data-glyph="bars" aria-hidden="true">
      {Array.from({ length: BAR_SLOTS }, (_, i) => {
        const on = i < filled;
        return (
          <span
            key={i}
            className="aetherChoiceBar"
            data-filled={on ? 'true' : 'false'}
            style={{ height: `${(i + 1) * 2 + 2}px`, opacity: on ? 1 : UNFILLED_BAR_OPACITY }}
          />
        );
      })}
    </span>
  );
}

export function TierTag({ tier }: { tier: TierId }) {
  const entry = TIER_TABLE[tier];
  const style: CSSProperties = entry.filled
    ? { background: entry.hex, color: NEUTRALS.bg, gap: GLYPH_GAP_PX }
    : { color: entry.hex, gap: GLYPH_GAP_PX };
  return (
    <span
      className={entry.filled ? 'aetherChoiceTag aetherChoiceTag--filled' : 'aetherChoiceTag'}
      data-tier={tier}
      style={style}
    >
      {entry.glyph === 'sparkle' ? <Sparkle /> : <Bars filled={entry.bars} />}
      <span>{entry.label}</span>
    </span>
  );
}

export type PickReadoutProps = {
  tier: TierId;
  effort: EffortLevel;
  reason: string;
  state: ReadoutState;
  auto: boolean;
  target?: { tier: TierId; effort: EffortLevel };
  haltedText?: string;
};

function stateText(props: PickReadoutProps): string | null {
  const { state, target } = props;
  if (state === 'queued' && target) return `next: ${target.tier} / ${target.effort}`;
  if (state === 'queuedModel' && target) return `model change applies at next resume: ${target.tier}`;
  if (state === 'unconfirmed') return 'sent';
  if (state === 'applying') return 'applying';
  if (state === 'blocked' || state === 'notApplied') return props.haltedText ?? null;
  return null;
}

export function PickReadout(props: PickReadoutProps) {
  const { tier, effort, reason, state, auto } = props;
  // Fable is display-only: always the locked disabled-row state (dim, 50% opacity, no glow).
  const disabled = tier === 'fable';
  const reducedMotion =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  // The pulse comes from the CSS class so the reduced-motion media query can switch it off.
  const { animation: _pulse, ...base } = readoutStyle(state, { reducedMotion });
  void _pulse;
  const style: CSSProperties = disabled ? { color: NEUTRALS.dim, opacity: DISABLED_OPACITY } : base;
  const text = stateText(props);
  const classes = ['aetherChoiceReadout'];
  if (!disabled && state === 'notApplied') classes.push(PULSE_CLASS);
  return (
    <span
      className={classes.join(' ')}
      data-state={state}
      data-disabled={disabled ? 'true' : undefined}
      aria-disabled={disabled ? 'true' : undefined}
      style={style}
    >
      <TierTag tier={tier} />
      <span data-part="effort">{effort}</span>
      {auto ? <span data-part="auto">auto</span> : null}
      <span data-part="reason">{reason}</span>
      {text ? <span data-part="state">{text}</span> : null}
    </span>
  );
}
