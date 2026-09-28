import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { fmtEta, short } from '../../utils/format';
import { NO_DATA, computeDashKpis, computeDashPulseMode, computeDashStatus, computeRateReadout, isSessionLive } from './dashboardMath';
import { Reactor, reactorNativeSize } from '../reactor/Reactor';
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
    if (pct === null) return null; // fall back to computeDashKpis' scan-based estimate, or NO_DATA
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
  const live = isSessionLive(state, Date.now());
  // Standby reads muted: a live colour on an idle console would claim a session (DESIGN.md).
  const statusC =
    state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : live ? colors.success : colors.textMuted;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>REACTOR STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {computeDashStatus(state.alarmLevel, live)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: DASH_REACTOR_SIZE, display: 'grid', placeItems: 'center', padding: '8px 0' }}>
        <div style={{ position: 'relative', width: DASH_REACTOR_SIZE, height: DASH_REACTOR_SIZE }}>
          <div style={reactorInnerStyle(reactorNativeSize(state.cfg.renderer))}>
            <Reactor />
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {computeRateReadout(state, live)} · {computeDashPulseMode(state.cfg)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => {
          const override = dk.k === 'DEPLETION ETA' || dk.k === 'CONTEXT' ? deriveTileOverride(dk.k, state) : null;
          const source: TileSource = override ? override.source : 'est';
          const v = override ? override.v : dk.v;
          const s = override ? override.s : dk.s;
          // A tile with no reading has nothing to attribute, so no source chip.
          const hasSourceChip = (dk.k === 'DEPLETION ETA' || dk.k === 'CONTEXT') && v !== NO_DATA;
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 14 }}>
        <Button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })} style={primaryActionStyle}>
          ⊕ OPEN TERMINAL
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
