import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { deriveDepletion, formatResetCountdown, STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

export function PlanUsageCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'failed'>('idle');

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function handleSync() {
    if (syncState === 'syncing' || !state.terminalAlive) return;
    setSyncState('syncing');
    try {
      const res = await window.aetherElectron?.plan.sync();
      if (res?.ok) {
        dispatch({
          type: 'SET_PLAN_USAGE_TIER',
          snapshot: { tier: res.tier!, weekModel: res.weekModel ?? null, capturedAtMs: res.capturedAtMs! },
        });
        setSyncState('idle');
      } else {
        setSyncState('failed');
      }
    } catch {
      setSyncState('failed');
    }
  }

  const session = deriveDepletion(state.statusline, null, now);
  const sevenDay = state.statusline?.sevenDay ?? null;
  const weekStale = state.statusline ? now - state.statusline.capturedAtMs > STATUSLINE_STALE_AFTER_MS : false;

  const tier = state.planUsageTier;
  const tierLabel = tier ? (tier.tier === 'max' ? 'MAX' : 'PRO') : '—';
  const freshnessLabel = !tier
    ? 'never synced — press Sync'
    : `as of ${fmtAgeMinutes(now - tier.capturedAtMs)}${syncState === 'failed' ? ' · last sync failed' : ''}`;

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={titleStyle(colors)}>PLAN USAGE</div>
          <span style={tierBadgeStyle(colors, tier?.tier ?? null)}>{tierLabel}</span>
        </div>
        <Button onClick={handleSync} disabled={!state.terminalAlive || syncState === 'syncing'} style={syncButtonStyle(colors)}>
          {syncState === 'syncing' ? 'Syncing…' : 'Sync'}
        </Button>
      </div>

      <div style={{ marginTop: 12 }}>
        <UsageBar
          label="SESSION (5H)"
          pct={session.usedPercentage}
          resetLabel={session.usedPercentage === null ? 'awaiting the first statusline reading' : `resets ${formatResetCountdown(session.msUntilReset)}`}
          stale={session.stale}
          available={session.usedPercentage !== null}
        />
        <UsageBar
          label="WEEK (7D)"
          pct={sevenDay?.usedPercentage ?? null}
          resetLabel={sevenDay ? `resets ${formatResetCountdown(sevenDay.resetsAtMs - now)}` : 'awaiting the first statusline reading'}
          stale={weekStale}
          available={sevenDay !== null}
        />
        {tier?.weekModel && (
          <UsageBar label="WEEK (MODEL)" pct={tier.weekModel.pct} resetLabel={freshnessLabel} stale={syncState === 'failed'} available={true} />
        )}
      </div>

      {!tier?.weekModel && <div style={{ font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 2 }}>{freshnessLabel}</div>}
    </div>
  );
}

function fmtAgeMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m <= 0 ? 'just now' : `${m}m ago`;
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function tierBadgeStyle(colors: ColorPalette, tier: 'pro' | 'max' | null): CSSProperties {
  return {
    font: `700 9px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: tier === 'max' ? colors.accentCyanSoft : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    padding: '2px 6px',
    borderRadius: 4,
  };
}
function syncButtonStyle(colors: ColorPalette): CSSProperties {
  return {
    cursor: 'pointer',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: colors.accentCyanSoft,
    padding: '4px 8px',
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 6,
  };
}

function UsageBar({
  label,
  pct,
  resetLabel,
  stale,
  available,
}: {
  label: string;
  pct: number | null;
  resetLabel: string;
  stale: boolean;
  available: boolean;
}) {
  const colors = useColors();
  if (!available || pct === null) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textMuted }}>{label}</div>
        <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 4 }}>no reading yet</div>
      </div>
    );
  }
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const warn = clamped >= 78;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textMuted }}>{label}</span>
        <span style={{ font: `700 12px/1 ${fonts.mono}`, color: warn ? colors.warn : colors.textBody }}>
          {clamped}%{stale ? ' (stale)' : ''}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 4 }}>
        <div style={{ height: '100%', width: `${clamped}%`, background: warn ? colors.warn : colors.accentCyanDeep }} />
      </div>
      <div style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 3 }}>{resetLabel}</div>
    </div>
  );
}
