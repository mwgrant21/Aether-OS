import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';
import { computeRealAgentBreakdown } from './analyticsMath';

export function AgentBreakdownCard() {
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = computeRealAgentBreakdown(state.realAgents, now);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>LONGEST-RUNNING AGENTS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.toolUseId} style={rowStyle}>
            <span style={avatarStyle}>{r.subagentType.slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={nameStyle}>{r.subagentType}</div>
              <div style={descStyle}>{r.description}</div>
            </div>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(r.elapsedMs)}</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const avatarStyle: CSSProperties = {
  width: 26,
  height: 26,
  flex: 'none',
  borderRadius: 7,
  display: 'grid',
  placeItems: 'center',
  font: `700 10px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const descStyle: CSSProperties = {
  marginTop: 2,
  font: `400 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
