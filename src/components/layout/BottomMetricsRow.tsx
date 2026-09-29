import { useState, type CSSProperties } from 'react';
import { fonts, glows, motion, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { fmt } from '../../utils/format';
import { NO_DATA, computeContextReading, computeSessionInfoRows, computeUsageBar, computeUsageRangeTotal, sessionCommandHistory } from '../dashboard/dashboardMath';
import { computeTopCommands } from '../analytics/analyticsMath';
import { deriveContextWindowCard } from './contextWindowCard';
import { EmptyState } from '../shared/EmptyState';

// Keeps an unlabelled bucket's label row at full line height.
const NBSP = '\u00A0';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type UsageRange = 'live' | 'daily' | 'weekly';
const RANGES: UsageRange[] = ['live', 'daily', 'weekly'];

export function BottomMetricsRow() {
  const colors = useColors();
  const { state } = useAetherStore();
  // Session-scoped to match "Commands run" below (state.commandsRun): see
  // sessionCommandHistory for why a restored cmdHist cannot leak in here.
  const sessionCommands = sessionCommandHistory(state);
  const topCommands = computeTopCommands(sessionCommands);
  const [range, setRange] = useState<UsageRange>('weekly');
  const now = new Date();

  const RANGE_CONFIG = {
    // Every third minute is labelled: twelve "-11m"-wide labels cannot sit
    // side by side in this card without pushing the total off its right edge.
    live: { values: state.realUsage.liveTokens, label: 'LAST 12 MIN', bucket: (i: number) => (i === 11 ? 'now' : (11 - i) % 3 === 0 ? `-${11 - i}m` : '') },
    daily: { values: state.realUsage.dailyTokens, label: 'TODAY', bucket: (i: number) => (i % 4 === 0 ? `${i}` : '') },
    weekly: { values: state.realUsage.weeklyTokens, label: 'THIS WEEK', bucket: (i: number) => DAY_LABELS[i] },
  } as const;

  const active = RANGE_CONFIG[range];
  const scanned = state.realUsage.lastScanAt !== null;
  const maxBar = Math.max(...active.values, 1); // avoid /0 before the first real scan completes
  const bars = active.values.map((v, i) => ({ d: active.bucket(i), ...computeUsageBar(v, maxBar, scanned) }));
  const rangeTotal = computeUsageRangeTotal(active.values, scanned);

  // Real Claude Code statusline data -- the same source ReactorStatusCard's
  // CONTEXT tile reads. See contextWindowCard.ts for why the window size,
  // the input-only token sum and the per-part breakdown all come from the
  // payload rather than from constants and ratios (issue #20).
  // The ring and headline percentage come from computeContextReading, the
  // same clamped reading the dashboard CONTEXT tile renders.
  const ctx = deriveContextWindowCard(state.statusline, now.getTime());
  const ctxReading = computeContextReading(state.statusline, now.getTime());
  const circ = 2 * Math.PI * 42;
  const ctxDash = `${((circ * (ctxReading?.pct ?? 0)) / 100).toFixed(1)} ${circ.toFixed(1)}`;
  const PART_COLORS = [colors.accentCyanDeep, colors.warn, colors.success];

  const session = computeSessionInfoRows(state, now);

  return (
    <div style={rootStyle}>
      <div style={cardStyle(colors)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ ...cardTitleStyle(colors), margin: 0 }}>TOKEN USAGE</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            {RANGES.map((r) => (
              <Button key={r} style={rangeChipStyle(colors, range === r)} onClick={() => setRange(r)} aria-pressed={range === r}>
                {r.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: 14 }}>
          <div data-testid="usage-bars" style={{ display: 'flex', alignItems: 'flex-end', gap: usageBarGap(bars.length), height: 74, flex: 1, minWidth: 0 }}>
            {bars.map((w, i) => (
              <div key={i} style={barColumnStyle}>
                <div data-usage-track="true" style={barTrackStyle}>
                  <div data-usage-bar="true" style={barStyle(colors, w.height, w.baseline)} />
                </div>
                <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, whiteSpace: 'nowrap' }}>{w.d || NBSP}</span>
              </div>
            ))}
          </div>
          <div style={{ flex: 'none', textAlign: 'right', whiteSpace: 'nowrap' }}>
            <div style={{ font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{active.label}</div>
            <div style={{ font: `700 24px/1 ${fonts.mono}`, color: colors.textPrimary, marginTop: 6 }}>{rangeTotal}</div>
            <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 4 }}>tokens</div>
            {range === 'weekly' && state.realUsage.weekOverWeekPct !== null && (
              <div
                style={{
                  font: `400 11px/1 ${fonts.ui}`,
                  color: state.realUsage.weekOverWeekPct <= 0 ? colors.success : colors.warn,
                  marginTop: 6,
                }}
              >
                {state.realUsage.weekOverWeekPct <= 0 ? '▼' : '▲'} {Math.abs(state.realUsage.weekOverWeekPct)}% vs last wk
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={cardStyle(colors)}>
        <h2 style={{ ...cardTitleStyle(colors), margin: 0 }}>CONTEXT WINDOW</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <div style={{ position: 'relative', width: 96, height: 96, flex: 'none' }}>
            {/* Decorative: the percentage beside it is the readable value. */}
            <svg aria-hidden="true" focusable="false" viewBox="0 0 100 100" style={{ width: 96, height: 96, transform: 'rotate(-90deg)' }}>
              <circle cx={50} cy={50} r={42} fill="none" stroke="rgba(20,50,64,.8)" strokeWidth={9} />
              {/* Glow-Is-State: with no reading there is no arc at all -- a round
                  cap on a 0-length dash would still draw a glowing dot. */}
              {ctxReading !== null && (
                <circle
                  data-context-arc="true"
                  cx={50}
                  cy={50}
                  r={42}
                  fill="none"
                  stroke={colors.accentCyanDeep}
                  strokeWidth={9}
                  strokeLinecap="round"
                  strokeDasharray={ctxDash}
                  style={{ filter: 'drop-shadow(0 0 4px rgba(95,240,255,.8))', transition: `stroke-dasharray ${motion.duration.slow} ${motion.easing.decelerate}` }}
                />
              )}
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
              <div>
                <div data-testid="context-pct" style={{ font: `700 22px/1 ${fonts.mono}`, color: ctxReading !== null ? colors.textPrimary : colors.textMuted }}>
                  {ctxReading !== null ? ctxReading.pctLabel : NO_DATA}
                </div>
                <div style={{ font: `400 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, marginTop: 3 }}>USED</div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={ctx.available ? { font: `700 14px/1 ${fonts.mono}`, color: colors.textBody } : { font: `400 12px/1.5 ${fonts.ui}`, color: colors.textSecondary }}>
              {ctx.available ? fmt(ctx.usedTokens as number) : 'No reading yet'}
            </div>
            <div style={{ font: ctx.available ? `400 11px/1 ${fonts.mono}` : `400 11px/1.4 ${fonts.ui}`, color: colors.textMuted, marginTop: 3 }}>
              {ctx.available
                ? `${ctx.windowSize !== null ? `/ ${fmt(ctx.windowSize)} tokens` : 'window size unreported'}${ctx.stale ? ' · stale' : ''}`
                : 'awaiting the first statusline reading'}
            </div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {ctx.parts.map((part, i) => (
                <div key={part.label} style={legendRowStyle(colors)}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: PART_COLORS[i % PART_COLORS.length] }} />
                  {part.label} <span style={{ marginLeft: 'auto', color: colors.textMuted }}>{fmt(part.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={cardStyle(colors)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ ...cardTitleStyle(colors), margin: 0 }}>TOP COMMANDS</h2>
          <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>THIS SESSION</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 13 }}>
          {topCommands.map((c, i) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{i + 1}</span>
              <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{c.name}</span>
              <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${(c.count / (topCommands[0]?.count ?? 1)) * 100}%`,
                    background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)',
                    boxShadow: '0 0 8px rgba(95,240,255,.5)',
                  }}
                />
              </span>
              <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{c.count}×</span>
            </div>
          ))}
          {!topCommands.length && <EmptyState message="No commands run this session." />}
        </div>
      </div>

      <div style={cardStyle(colors)}>
        <h2 style={{ ...cardTitleStyle(colors), margin: 0 }}>SESSION INFO</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 13 }}>
          {session.map((s) => (
            <div key={s.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ font: `400 11px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textMuted }}>{s.k}</span>
              <span style={{ font: `700 12px/1 ${fonts.mono}`, color: colors.textBody }}>{s.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 'none', display: 'grid', gridTemplateColumns: '1.15fr 1fr 1.1fr .95fr', gap: 14 };
function cardStyle(colors: ColorPalette): CSSProperties {
  // contain: paint keeps the usage bars' slab (translated below its clip-path baseline)
  // out of the ancestors' scroll height; the 15px padding still fits focus rings and glows.
  return { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, contain: 'paint' };
}
function cardTitleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function rangeChipStyle(colors: ColorPalette, active: boolean): CSSProperties {
  return {
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '4px 8px',
    borderRadius: 5,
    color: active ? colors.accentCyanSoft : colors.textDim,
    border: active ? '1px solid rgba(95,220,255,.35)' : undefined,
    cursor: 'pointer',
    userSelect: 'none',
  };
}
// A baseline (zero-value or pre-scan) bar renders flat and dim -- no
// gradient, no glow -- so it reads as "nothing observed", never as a small
// real reading. See dashboardMath.ts's computeUsageBar.
//
// The bar is a fixed BAR_MAX_HEIGHT slab that slides up out of a track
// (translateY), never a scaled one: transform still animates on the
// compositor, but translate leaves the 3px top radius and the glow at their
// true size where scaleY squashed both in proportion to the reading. The
// track clips only its bottom edge (clip-path, not overflow: hidden, which
// would also cut the glow off the sides and top), hiding the part of the slab
// still below the baseline.
function barStyle(colors: ColorPalette, h: number, baseline: boolean): CSSProperties {
  return {
    width: '100%',
    height: BAR_MAX_HEIGHT,
    // A 2px baseline tick would round away to nothing under a 3px radius.
    borderRadius: baseline ? 0 : '3px 3px 0 0',
    transform: `translateY(${BAR_MAX_HEIGHT - h}px)`,
    background: baseline ? colors.chipBorder : `linear-gradient(180deg, ${colors.accentCyan}, ${colors.accentCyanDeep})`,
    boxShadow: baseline ? undefined : glows.active,
    transition: `transform ${motion.duration.slow} ${motion.easing.decelerate}`,
  };
}
// Tallest bar computeUsageBar can return (20 + 52).
export const BAR_MAX_HEIGHT = 72;
// Clip only below the baseline; the negative insets leave room for the
// active glow (0 0 10px) on the sides and above the tallest bar.
export const BAR_TRACK_CLIP = 'inset(-12px -12px 0 -12px)';
const barTrackStyle: CSSProperties = { width: '100%', height: BAR_MAX_HEIGHT, clipPath: BAR_TRACK_CLIP };
export const MIN_BAR_WIDTH = 2;
// minWidth lets a column shrink below its label's width (the label simply
// overflows into its unlabelled neighbours); without it, the labelled columns
// keep their text width and the rest collapse to 0px. The 2px floor keeps
// every bucket visible even at the densest range.
const barColumnStyle: CSSProperties = { flex: 1, minWidth: MIN_BAR_WIDTH, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 };
/**
 * Gap between usage bars, tightened as the bucket count grows so a dense
 * range (DAILY's 24 hours) still leaves every bar a visible width in the
 * card: 7 buckets breathe at 9px, 12 at 6px, 24 at 3px.
 */
export function usageBarGap(count: number): number {
  if (count <= 7) return 9;
  if (count <= 12) return 6;
  return 3;
}
function legendRowStyle(colors: ColorPalette): CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 7, font: `400 11px/1 ${fonts.mono}`, color: colors.textSecondary };
}
