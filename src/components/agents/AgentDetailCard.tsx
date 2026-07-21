import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { fmtElapsed } from '../../utils/format';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

export function AgentDetailCard({ agent }: { agent: RealAgentDispatch | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!agent) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO AGENT SELECTED</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            No agent dispatches are currently running.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={avatarStyle}>{agent.subagentType.slice(0, 2).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{agent.subagentType}</div>
            {agent.model && <span style={modelBadgeStyle}>{agent.model}</span>}
          </div>
          <div style={descStyle}>{agent.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>
          {fmtElapsed(now - new Date(agent.startedAt).getTime())}
        </div>
      </div>

      <div style={promptWrapStyle}>
        <div style={sectionLabelStyle}>PROMPT</div>
        <div style={promptTextStyle}>{agent.prompt || 'no prompt text available'}</div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  flex: 'none',
  borderRadius: 10,
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 15px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const descStyle: CSSProperties = {
  marginTop: 4,
  font: `400 12px/1.4 ${fonts.ui}`,
  color: colors.textMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const modelBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 9px/1 ${fonts.mono}`,
  letterSpacing: 0.5,
  color: colors.textMuted,
  border: `1px solid ${colors.chipBorder}`,
  padding: '3px 7px',
  borderRadius: 5,
};
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const promptWrapStyle: CSSProperties = { marginTop: 20, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
const promptTextStyle: CSSProperties = {
  marginTop: 8,
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  font: `400 13px/1.6 ${fonts.ui}`,
  color: colors.textSecondary,
  whiteSpace: 'pre-wrap',
};
