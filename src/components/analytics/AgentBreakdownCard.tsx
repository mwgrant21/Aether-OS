import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import { computeAgentBreakdown } from './analyticsMath';

export function AgentBreakdownCard() {
  const { state } = useAetherStore();
  const rows = computeAgentBreakdown(state.agents);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>AGENT BURN BREAKDOWN</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.name} style={rowStyle}>
            <span style={swatchStyle(r.hue)} />
            <span style={nameStyle}>{r.name}</span>
            <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: 62, height: 22, flex: 'none' }}>
              <polyline points={spark(r.hist)} fill="none" stroke={r.hue} strokeWidth={1.4} strokeLinejoin="round" />
            </svg>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: r.hue, width: 40, textAlign: 'right' }}>{r.pct}%</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no active agents</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
function swatchStyle(hue: string): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', flex: 'none', background: hue, boxShadow: `0 0 8px ${hue}` };
}
const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
