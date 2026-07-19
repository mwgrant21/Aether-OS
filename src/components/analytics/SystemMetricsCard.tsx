import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import { computeSysMetricStats } from './analyticsMath';

export function SystemMetricsCard() {
  const { state } = useAetherStore();
  const rows = computeSysMetricStats(state.sys);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>SYSTEM METRICS</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        {rows.map((m) => (
          <div key={m.label} style={metricTileStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{m.label}</span>
              <span style={{ font: `700 15px/1 ${fonts.mono}`, color: colors.textBody }}>{Math.round(m.val)}%</span>
            </div>
            <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: '100%', height: 22, marginTop: 7, display: 'block' }}>
              <polyline
                points={spark(m.hist)}
                fill="none"
                stroke={colors.accentCyanDeep}
                strokeWidth={1.4}
                strokeLinejoin="round"
                style={{ filter: 'drop-shadow(0 0 3px rgba(95,240,255,.7))' }}
              />
            </svg>
            <div style={{ marginTop: 6, font: `400 9px/1 ${fonts.mono}`, color: colors.textDim }}>
              min {Math.round(m.min)}% · avg {Math.round(m.avg)}% · max {Math.round(m.max)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const metricTileStyle: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.16)', background: 'rgba(6,20,28,.5)' };
