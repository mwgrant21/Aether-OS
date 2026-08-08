import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { fmt, fmtEta, short } from '../../utils/format';
import { computeDashKpis, computeDashPulseMode, computeDashStatus } from './dashboardMath';
import { deriveDepletion, formatResetCountdown } from '../../shared/depletion';
import type { AetherState } from '../../state/types';

type TileSource = 'live' | 'stale' | 'est';

/**
 * DEPLETION ETA and CONTEXT are the two dashboard tiles with a real,
 * statusline-backed alternative to today's estimate/fictional value. This
 * derives the override (value/detail/source/stale) for those two tile keys
 * only; every other tile from computeDashKpis renders unchanged. Kept local
 * to the component (rather than folded into computeDashKpis) so the existing,
 * already-tested `DashKpi[]` shape in dashboardMath.ts/.test.ts is untouched.
 */
function deriveTileOverride(
  key: string,
  state: AetherState,
): { v: string; s: string; source: TileSource; stale: boolean } | null {
  // Both tiles judge freshness off the same statusline capture, via
  // deriveDepletion's stale computation (which is correct even when
  // state.statusline.fiveHour is null) -- so a percentage captured hours ago
  // can never render LIVE on one tile while the sibling tile (correctly)
  // shows it as stale.
  const stale = deriveDepletion(state.statusline, null, Date.now()).stale;

  if (key === 'DEPLETION ETA') {
    const depletion = deriveDepletion(state.statusline, null, Date.now());
    if (depletion.source !== 'statusline') return null; // fall back to today's estimate
    const etaPart =
      depletion.msUntilDepleted === null ? '—' : depletion.msUntilDepleted <= 0 ? 'now' : fmtEta(depletion.msUntilDepleted / 1000);
    const prefix = stale ? '~' : '';
    return {
      v: `${prefix}${etaPart} · resets ${formatResetCountdown(depletion.msUntilReset)}`,
      s: 'server rate limit',
      source: stale ? 'stale' : 'live',
      stale,
    };
  }
  if (key === 'CONTEXT') {
    const snap = state.statusline;
    const pct = snap?.contextUsedPercentage ?? null;
    if (pct === null) return null; // fall back to today's fictional value
    const usage = snap?.contextUsage ?? null;
    const windowSize = snap?.contextWindowSize ?? null;
    // Matches contextUsedPercentage's own input-only definition
    // (input + cache-creation + cache-read tokens) -- outputTokens is
    // deliberately excluded here, since including it would sum against a
    // different basis than the headline percentage and the two would
    // visibly disagree.
    const detail =
      usage === null
        ? 'post-/compact snapshot'
        : windowSize === null
          ? short(usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens)
          : `${short(usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens)} / ${short(windowSize)}`;
    const prefix = stale ? '~' : '';
    return { v: `${prefix}${Math.round(pct)}%`, s: detail, source: stale ? 'stale' : 'live', stale };
  }
  return null;
}

export function ReactorStatusCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const statusC = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>REACTOR STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {computeDashStatus(state.alarmLevel)}
        </div>
      </div>

      <div style={{ flex: 'none', display: 'grid', placeItems: 'center', padding: '18px 0 6px' }}>
        <div style={{ position: 'relative', width: 120, height: 120, display: 'grid', placeItems: 'center' }}>
          <div style={ringOuterStyle} />
          <div style={ringInnerStyle} />
          <div className="pulse-anim" style={glowDiscStyle} />
          <div className="pulse-anim" style={coreDiscStyle} />
        </div>
      </div>
      <div style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {fmt(state.rate)} tok/min · {computeDashPulseMode(state.cfg)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => {
          const hasSourceChip = dk.k === 'DEPLETION ETA' || dk.k === 'CONTEXT';
          const override = hasSourceChip ? deriveTileOverride(dk.k, state) : null;
          const source: TileSource = override ? override.source : 'est';
          const v = override ? override.v : dk.v;
          const s = override ? override.s : dk.s;
          const isWarn = override?.stale ?? false;
          return (
            <div key={dk.k} style={kpiTileStyle(colors)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ font: `600 9px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{dk.k}</div>
                {hasSourceChip && (
                  <span style={sourceChipStyle(colors, source)}>
                    {source === 'live' ? 'LIVE' : source === 'stale' ? 'STALE' : 'EST'}
                  </span>
                )}
              </div>
              <div style={kpiValueStyle(colors, isWarn)}>{v}</div>
              <div style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 5 }}>{s}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 14 }}>
        <Button onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={primaryActionStyle}>
          ⊕ SPAWN AGENT
        </Button>
        <Button
          onClick={() => {
            dispatch({ type: 'RUN_COMMAND', raw: 'sweep' });
            dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Memory' });
          }}
          style={secondaryActionStyle}
        >
          MEMORY SWEEP
        </Button>
        <Button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })} style={secondaryActionStyle}>
          OPEN TERMINAL
        </Button>
        {/* Mission Composer modal is out of scope for this plan — button renders for visual
            fidelity but is intentionally not wired (see Global Constraints #1). */}
        <span style={{ ...composeActionStyle(colors), cursor: 'default' }}>◇ COMPOSE MISSION</span>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    gridRow: 'span 2',
    padding: 16,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
const ringOuterStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '2px dashed rgba(95,240,255,.3)',
  animation: 'spin 16s linear infinite',
};
const ringInnerStyle: CSSProperties = {
  position: 'absolute',
  inset: 16,
  borderRadius: '50%',
  border: '1px dashed rgba(120,235,255,.45)',
  animation: 'spinRev 10s linear infinite',
};
const glowDiscStyle: CSSProperties = {
  position: 'absolute',
  width: 76,
  height: 76,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(95,240,255,.28), transparent 66%)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const coreDiscStyle: CSSProperties = {
  position: 'relative',
  width: 54,
  height: 54,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 44% 38%, #fff, #7ef0ff 30%, #17b8d8 64%, #0a5f74 100%)',
  boxShadow: '0 0 22px rgba(95,240,255,.9), 0 0 52px rgba(80,220,255,.45)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
function kpiTileStyle(colors: ColorPalette): CSSProperties {
  // No fixed height: the DEPLETION ETA value can be a much longer live string
  // (e.g. "~2h 14m · resets 3h 01m") than the estimate it replaces ("3h 12m"),
  // and this tile must be able to grow to an intrinsic, wrapped height rather
  // than clip or force the grid to blow out. minWidth: 0 keeps a long
  // unbroken value from forcing the 2-column grid's track wider than
  // intended; the sibling action-button row below already uses
  // marginTop: 'auto' so it gets pushed down gracefully if this row grows.
  return { padding: '11px 12px', borderRadius: 9, border: `1px solid ${colors.chromeBorder}`, background: colors.panelInset, minWidth: 0 };
}
function kpiValueStyle(colors: ColorPalette, isWarn: boolean): CSSProperties {
  return {
    font: `700 17px/1.25 ${fonts.mono}`,
    color: isWarn ? colors.warn : colors.textPrimary,
    marginTop: 7,
    overflowWrap: 'break-word',
  };
}
function sourceChipStyle(colors: ColorPalette, source: TileSource): CSSProperties {
  return {
    font: `700 8px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: source === 'live' ? colors.success : source === 'stale' ? colors.warn : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '2px 5px',
    borderRadius: 4,
  };
}
const primaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
  padding: '10px 0',
  borderRadius: 8,
  boxShadow: '0 0 14px rgba(95,240,255,.4)',
};
const secondaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#bff4ff',
  border: '1px solid rgba(95,220,255,.45)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.1)',
};
function composeActionStyle(colors: ColorPalette): CSSProperties {
  return {
    gridColumn: 'span 2',
    textAlign: 'center',
    font: `600 12px/1 ${fonts.ui}`,
    letterSpacing: 2,
    color: colors.textPrimary,
    border: '1px solid rgba(95,220,255,.55)',
    padding: '11px 0',
    borderRadius: 8,
    background: 'rgba(23,184,216,.18)',
    boxShadow: 'inset 0 0 18px rgba(95,240,255,.12)',
  };
}
