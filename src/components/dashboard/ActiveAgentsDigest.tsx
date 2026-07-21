import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';

export function ActiveAgentsDigest() {
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.realAgents.map((a) => (
          <div key={a.toolUseId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={avatarStyle}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
            <span style={nameStyle}>{a.subagentType}</span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
          </div>
        ))}
        {state.realAgents.length === 0 && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  padding: 14,
  background: 'rgba(10,22,26,0.55)',
  border: `1px solid ${colors.panelBorder}`,
  borderRadius: 10,
};

const titleStyle: CSSProperties = {
  font: `700 11px/1 ${fonts.ui}`,
  letterSpacing: 1.2,
  color: colors.textMuted,
};

const avatarStyle: CSSProperties = {
  flex: 'none',
  width: 24,
  height: 24,
  borderRadius: 7,
  display: 'grid',
  placeItems: 'center',
  font: `700 10px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: `600 12px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
