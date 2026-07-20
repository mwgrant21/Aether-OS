import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';
import { computeTopCommands } from '../analytics/analyticsMath';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function BottomMetricsRow() {
  const { state } = useAetherStore();
  const topCommands = computeTopCommands(state.cmdHist);

  const maxBar = Math.max(...state.realUsage.weeklyTokens, 1); // avoid /0 before the first real scan completes
  const weekly = state.realUsage.weeklyTokens.map((v, i) => ({ d: DAY_LABELS[i], h: Math.round(20 + (v / maxBar) * 52) }));
  const weekTotal = fmt(state.realUsage.weeklyTokens.reduce((sum, v) => sum + v, 0));

  const ctxTotal = 125000;
  const ctxPct = Math.round((state.ctxUsed / ctxTotal) * 100);
  const circ = 2 * Math.PI * 42;
  const ctxDash = `${((circ * ctxPct) / 100).toFixed(1)} ${circ.toFixed(1)}`;
  const inTok = Math.round(state.ctxUsed * 0.58);
  const outTok = Math.round(state.ctxUsed * 0.42);

  const session = [
    { k: 'Session start', v: '2:15 PM' },
    { k: 'Uptime', v: '3h 42m' },
    { k: 'Commands run', v: fmt(state.commandsRun) },
    { k: 'Agents active', v: String(state.agents.length) },
    { k: 'Tokens used', v: fmt(state.realUsage.usedThisMonth) },
  ];

  return (
    <div style={rootStyle}>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOKEN USAGE</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={rangeChipStyle(false)}>LIVE</span>
            <span style={rangeChipStyle(false)}>DAILY</span>
            <span style={rangeChipStyle(true)}>WEEKLY</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 9, height: 74, flex: 1 }}>
            {weekly.map((w) => (
              <div key={w.d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <div style={barStyle(w.h)} />
                <span style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim }}>{w.d}</span>
              </div>
            ))}
          </div>
          <div style={{ flex: 'none', textAlign: 'right' }}>
            <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>THIS WEEK</div>
            <div style={{ font: `700 24px/1 ${fonts.mono}`, color: colors.textPrimary, marginTop: 6 }}>{weekTotal}</div>
            <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 4 }}>tokens</div>
            {state.realUsage.weekOverWeekPct !== null && (
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

      <div style={cardStyle}>
        <div style={cardTitleStyle}>CONTEXT WINDOW</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
          <div style={{ position: 'relative', width: 96, height: 96, flex: 'none' }}>
            <svg viewBox="0 0 100 100" style={{ width: 96, height: 96, transform: 'rotate(-90deg)' }}>
              <circle cx={50} cy={50} r={42} fill="none" stroke="rgba(20,50,64,.8)" strokeWidth={9} />
              <circle
                cx={50}
                cy={50}
                r={42}
                fill="none"
                stroke={colors.accentCyanDeep}
                strokeWidth={9}
                strokeLinecap="round"
                strokeDasharray={ctxDash}
                style={{ filter: 'drop-shadow(0 0 4px rgba(95,240,255,.8))', transition: 'stroke-dasharray .5s ease' }}
              />
            </svg>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
              <div>
                <div style={{ font: `700 22px/1 ${fonts.mono}`, color: colors.textPrimary }}>{ctxPct}%</div>
                <div style={{ font: `400 9px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, marginTop: 3 }}>USED</div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: `700 14px/1 ${fonts.mono}`, color: colors.textBody }}>{fmt(state.ctxUsed)}</div>
            <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 3 }}>/ 125,000 tokens</div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={legendRowStyle}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors.accentCyanDeep }} />
                Input <span style={{ marginLeft: 'auto', color: colors.textMuted }}>{fmt(inTok)}</span>
              </div>
              <div style={legendRowStyle}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colors.success }} />
                Output <span style={{ marginLeft: 'auto', color: colors.textMuted }}>{fmt(outTok)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOP COMMANDS</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>RECENT</div>
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
          {!topCommands.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' }}>no commands run yet</div>}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={cardTitleStyle}>SESSION INFO</div>
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
const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
const cardTitleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
function rangeChipStyle(active: boolean): CSSProperties {
  return {
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '4px 8px',
    borderRadius: 5,
    color: active ? colors.accentCyanSoft : colors.textDim,
    border: active ? '1px solid rgba(95,220,255,.35)' : undefined,
  };
}
function barStyle(h: number): CSSProperties {
  return {
    width: '100%',
    borderRadius: '3px 3px 0 0',
    height: h,
    background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
    boxShadow: '0 0 10px rgba(95,240,255,.4)',
    transition: 'height .5s ease',
  };
}
const legendRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, font: `400 11px/1 ${fonts.mono}`, color: colors.textSecondary };
