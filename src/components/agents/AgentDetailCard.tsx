import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import type { Agent } from '../../state/types';
import { agentApprovals, agentStatusLabel } from './agentsMath';

export function AgentDetailCard({ agent }: { agent: Agent | null }) {
  const { state, dispatch } = useAetherStore();

  if (!agent) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO AGENT SELECTED</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Spawn an agent or reactivate one from the idle pool to see it here.
          </div>
        </div>
      </div>
    );
  }

  const status = agentStatusLabel(agent);
  const statusC = status === 'PAUSED' ? colors.warn : colors.success;
  const approvals = agentApprovals(state.approvals, agent.name);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={avatarStyle(agent.hue)}>{agent.i}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{agent.name}</div>
          <div style={taskStyle}>{agent.task}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {status}
        </div>
      </div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${Math.round(agent.pct)}%`, background: agent.hue, boxShadow: `0 0 10px ${agent.hue}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: agent.hue }}>{Math.round(agent.pct)}% complete</span>
        <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>ETA {agent.eta}</span>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={sectionLabelStyle}>TOKEN DRAW</div>
        <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: '100%', height: 44, marginTop: 7, display: 'block' }}>
          <polyline
            points={spark(agent.hist)}
            fill="none"
            stroke={agent.hue}
            strokeWidth={1.4}
            strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${agent.hue})` }}
          />
        </svg>
      </div>

      <div style={filesWrapStyle}>
        <div style={sectionLabelStyle}>FILES</div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agent.files.map((f, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, font: `400 12px/1.5 ${fonts.mono}` }}>
              <span style={{ color: f.c, flex: 'none' }}>{f.s}</span>
              <span style={{ color: colors.textSecondary }}>{f.n}</span>
            </div>
          ))}
          {!agent.files.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no files touched yet</div>}
        </div>
      </div>

      {!!approvals.length && (
        <div style={{ marginTop: 16 }}>
          <div style={sectionLabelStyle}>PENDING AUTHORIZATION</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {approvals.map((ap) => (
              <div key={ap.id} style={apprRowStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ font: `600 12px/1.3 ${fonts.ui}`, color: colors.textPrimary }}>{ap.action}</span>
                  <span style={riskBadgeStyle(ap.risk)}>{ap.risk}</span>
                </div>
                <div style={{ font: `400 10px/1.5 ${fonts.mono}`, color: colors.textMuted, marginTop: 4 }}>{ap.detail}</div>
                <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: true })} style={approveBtnStyle}>
                    APPROVE
                  </span>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: false })} style={denyBtnStyle}>
                    DENY
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 16 }}>
        <span onClick={() => dispatch({ type: 'TOGGLE_AGENT_PAUSE', name: agent.name })} style={secondaryActionStyle}>
          {status === 'PAUSED' ? '▶ RESUME' : '⏸ PAUSE'}
        </span>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `kill ${agent.name}` })} style={dangerActionStyle}>
          ✕ TERMINATE
        </span>
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
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 46,
    height: 46,
    flex: 'none',
    borderRadius: 10,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 15px/1 ${fonts.mono}`,
    color: hue,
  };
}
const taskStyle: CSSProperties = {
  marginTop: 4,
  font: `400 12px/1.4 ${fonts.ui}`,
  color: colors.textMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const filesWrapStyle: CSSProperties = { marginTop: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
const apprRowStyle: CSSProperties = {
  padding: '10px 11px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.2)',
  background: 'rgba(9,28,38,.7)',
};
function riskBadgeStyle(risk: 'HIGH' | 'MED' | 'LOW'): CSSProperties {
  const c = risk === 'HIGH' ? colors.danger : risk === 'MED' ? colors.warn : colors.success;
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '3px 6px', borderRadius: 4 };
}
const approveBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.success,
  border: '1px solid rgba(59,224,160,.45)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(59,224,160,.08)',
};
const denyBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(255,90,90,.06)',
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
const dangerActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(255,90,90,.06)',
};
