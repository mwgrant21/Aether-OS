import type { CSSProperties } from 'react';
import { dotGlow, fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { fmt, fmtEta } from '../../utils/format';
import { NO_DATA, computeDashKpis, computeDashStatus, computeRateLine, isSessionLive, statusDotGlows } from './dashboardMath';
import { Reactor, reactorNativeSize } from '../reactor/Reactor';
import { deriveDepletion, formatResetCountdown } from '../../shared/depletion';
import type { AetherState } from '../../state/types';
import { OpenTerminalButton } from './OpenTerminalButton';

type TileSource = 'live' | 'stale' | 'est';

/**
 * DEPLETION ETA is the one dashboard tile backed by the statusline, which is
 * what earns it a LIVE/STALE source chip. This derives its override
 * (value/detail/source/stale); every other tile from computeDashKpis renders
 * unchanged. Freshness is judged off the capture's age against
 * STATUSLINE_STALE_AFTER_MS, the same rule the footer's CONTEXT WINDOW card uses.
 */
function deriveDepletionOverride(state: AetherState): { v: string; s: string; source: TileSource; stale: boolean } | null {
  const depletion = deriveDepletion(state.statusline, null, Date.now());
  const stale = depletion.stale;
  if (depletion.source !== 'statusline') return null; // fall back to today's estimate
  const etaPart =
    depletion.msUntilDepleted === null ? NO_DATA : depletion.msUntilDepleted <= 0 ? 'now' : fmtEta(depletion.msUntilDepleted / 1000);
  // `~` marks a stale value; with no value there is nothing to qualify.
  const prefix = stale && etaPart !== NO_DATA ? '~' : '';
  return {
    v: `${prefix}${etaPart} · resets ${formatResetCountdown(depletion.msUntilReset)}`,
    s: 'server rate limit',
    source: stale ? 'stale' : 'live',
    stale,
  };
}

/**
 * The reactor is a canvas instrument, so assistive tech gets its reading as a
 * static image label built from the same status and source the card prints:
 * the status from computeDashStatus, the rate from
 * state.realUsage.burnRatePerMin under computeRateReadout's own gating (live
 * and scanned). Built from the field, not by re-parsing the printed readout.
 *
 * Not a live region: the always-mounted Footer carries the single reactor
 * status announcement, so a transition isn't announced twice while the
 * Dashboard is open.
 */
export function computeReactorAriaLabel(state: AetherState, live: boolean): string {
  const status = computeDashStatus(state.alarmLevel, live);
  const hasRate = live && state.realUsage.lastScanAt !== null;
  const rate = hasRate ? `${fmt(state.realUsage.burnRatePerMin)} tokens per minute` : 'no live rate';
  return `Reactor: ${status}, ${rate}`;
}

export function ReactorStatusCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const live = isSessionLive(state, Date.now());
  // Standby reads muted: a live colour on an idle console would claim a session (DESIGN.md).
  const statusC =
    state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : live ? colors.success : colors.textMuted;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>REACTOR STATUS</h2>
        {/* Not a live region: the Footer carries the status announcement. */}
        <div data-testid="reactor-status-label" style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          {/* Glow-Is-State: the dot glows only when live or alarmed; flat at STANDBY. Same gate as the Footer's dot. */}
          <span
            data-testid="reactor-status-dot"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusC,
              boxShadow: statusDotGlows(state.alarmLevel, live) ? dotGlow(statusC) : undefined,
            }}
          />
          {computeDashStatus(state.alarmLevel, live)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: DASH_REACTOR_SIZE, display: 'grid', placeItems: 'center', padding: '8px 0' }}>
        <div role="img" aria-label={computeReactorAriaLabel(state, live)} style={{ position: 'relative', width: DASH_REACTOR_SIZE, height: DASH_REACTOR_SIZE }}>
          <div style={reactorInnerStyle(reactorNativeSize(state.cfg.renderer))}>
            <Reactor />
          </div>
        </div>
      </div>
      <div data-testid="reactor-rate-line" style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {computeRateLine(state, live)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => {
          const override = dk.k === 'DEPLETION ETA' ? deriveDepletionOverride(state) : null;
          const source: TileSource = override ? override.source : 'est';
          const v = override ? override.v : dk.v;
          const s = override ? override.s : dk.s;
          // A tile with no reading has nothing to attribute, so no source chip.
          const hasSourceChip = dk.k === 'DEPLETION ETA' && v !== NO_DATA;
          const isWarn = override?.stale ?? false;
          return (
            <div key={dk.k} data-testid="kpi-tile" data-kpi={dk.k} style={kpiTileStyle(colors)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{dk.k}</div>
                {hasSourceChip && (
                  <span style={sourceChipStyle(colors, source)}>{source === 'live' ? 'LIVE' : source === 'stale' ? 'STALE' : 'EST'}</span>
                )}
              </div>
              <div data-testid="kpi-value" style={kpiValueStyle(colors, isWarn)}>
                {v}
              </div>
              <div data-testid="kpi-caption" style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 5 }}>
                {s}
              </div>
            </div>
          );
        })}
      </div>

      {/* MEMORY SWEEP was removed; OPEN TERMINAL is the card's only action. */}
      <OpenTerminalButton live={live} />
    </div>
  );
}

// No gridRow span: the Dashboard is two columns now and this card fills the left one.
function cardStyle(colors: ColorPalette): CSSProperties {
  return {
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
// The dashboard centrepiece. The frame is a fixed 1536x1024 design scaled as a
// whole (frameScale.ts), so a fixed size here fills the panel's free band
// between the header and the KPI tiles at every window size.
const DASH_REACTOR_SIZE = 360;
function reactorInnerStyle([nativeWidth, nativeHeight]: [number, number]): CSSProperties {
  const scale = DASH_REACTOR_SIZE / Math.max(nativeWidth, nativeHeight);
  return {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: nativeWidth,
    height: nativeHeight,
    // Same centring as Sidebar.tsx's reactorMiniInnerStyle: ReactorCore's
    // glow/core canvases have no offsets and rely on a grid/placeItems:center
    // parent, and StormCore centres itself the same way. Scale only through
    // this transform, never by resizing the reactor.
    display: 'grid',
    placeItems: 'center',
    transform: `translate(-50%, -50%) scale(${scale})`,
  };
}
function kpiTileStyle(colors: ColorPalette): CSSProperties {
  // No fixed height: the DEPLETION ETA value can be a much longer live string
  // (e.g. "~2h 14m · resets 3h 01m") than the estimate it replaces ("3h 12m"),
  // and this tile must be able to grow to an intrinsic, wrapped height rather
  // than clip or force the grid to blow out. minWidth: 0 keeps a long
  // unbroken value from forcing the 2-column grid's track wider than
  // intended; the reactor slot above is flex: 1, so it gives up its spare
  // height (down to DASH_REACTOR_SIZE) before this row pushes anything off.
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
    font: `700 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: source === 'live' ? colors.success : source === 'stale' ? colors.warn : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '2px 5px',
    borderRadius: 4,
  };
}
