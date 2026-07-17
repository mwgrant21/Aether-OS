import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';

export function SystemOverviewCard() {
  const { state } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>SYSTEM OVERVIEW</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.success }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: colors.success, boxShadow: '0 0 8px rgba(59,224,160,.8)' }} />
          NOMINAL
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 13 }}>
        {state.sys.map((m) => (
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
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { flex: 'none', padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const metricTileStyle: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.16)', background: 'rgba(6,20,28,.5)' };
