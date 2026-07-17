import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';

const TAB_LABELS = ['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files'];
const OP_MODES: { key: OpMode; label: string; tip: string }[] = [
  { key: 'PLAN', label: '◇ PLAN', tip: 'Brainstorm & plan — throttled burn, everything queued for approval' },
  { key: 'EDITS', label: '✎ EDITS', tip: 'Accept edits — agents work, risky actions queue for approval' },
  { key: 'AUTO', label: '⚡ AUTO', tip: 'Full auto — low/med actions auto-approved, max burn' },
];

export function TopBar() {
  const { state, dispatch } = useAetherStore();
  const pendingCount = state.approvals.length;
  const hasPending = pendingCount > 0;
  const apprBtnC = hasPending ? colors.warn : colors.accentCyanSoft;
  const apprBtnBorder = hasPending ? 'rgba(245,198,107,.5)' : 'rgba(80,190,220,.25)';

  return (
    <div style={rootStyle}>
      <div style={logoWrapStyle}>
        <div style={logoDotStyle} />
        <div style={logoTextStyle}>
          AETHER<span style={{ color: colors.textMuted, fontWeight: 500 }}> OS</span>
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 4 }}>
        {TAB_LABELS.map((label) => {
          const on = label === state.activeTab;
          return (
            <div key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={tabStyle(on)}>
              {label}
            </div>
          );
        })}
      </div>

      <div style={opModeGroupStyle}>
        {OP_MODES.map((om) => {
          const on = state.cfg.opMode === om.key;
          return (
            <span key={om.key} title={om.tip} onClick={() => dispatch({ type: 'SET_OP_MODE', mode: om.key })} style={opModeStyle(on, om.key)}>
              {om.label}
            </span>
          );
        })}
      </div>

      <div style={{ position: 'relative', flex: 'none', marginRight: 10 }}>
        <div onClick={() => dispatch({ type: 'TOGGLE_APPROVALS' })} style={{ ...iconButtonStyle, borderColor: apprBtnBorder, color: apprBtnC }}>
          ⛉
        </div>
        {hasPending && <span style={apprBadgeStyle}>{pendingCount}</span>}
        {state.apprOpen && (
          <div style={apprPanelStyle}>
            <div style={panelTitleStyle}>⛉ APPROVAL QUEUE — agents awaiting authorization</div>
            {state.approvals.map((ap) => (
              <div key={ap.id} style={apprRowStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={apprAvatarStyle(ap.hue)}>{ap.i}</span>
                  <span style={apprActionStyle}>{ap.action}</span>
                  <span style={riskBadgeStyle(ap.risk)}>{ap.risk}</span>
                </div>
                <div style={apprDetailStyle}>
                  {ap.agent} · {ap.detail}
                </div>
                <div style={{ display: 'flex', gap: 7 }}>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: true })} style={approveBtnStyle}>
                    APPROVE
                  </span>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: false })} style={denyBtnStyle}>
                    DENY
                  </span>
                </div>
              </div>
            ))}
            {!state.approvals.length && <div style={emptyStateStyle}>queue clear — no agents awaiting authorization</div>}
          </div>
        )}
      </div>

      <div style={{ position: 'relative', flex: 'none', marginRight: 10 }}>
        <div onClick={() => dispatch({ type: 'TOGGLE_NOTIFS' })} style={{ ...iconButtonStyle, color: colors.accentCyanSoft }}>
          ◈
        </div>
        {state.unread > 0 && <span style={notifBadgeStyle}>{state.unread}</span>}
        {state.notifOpen && (
          <div style={notifPanelStyle}>
            <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>NOTIFICATIONS</div>
            {state.notifs.map((nf, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 8, font: `400 10.5px/1.5 ${fonts.mono}` }}>
                <span style={{ color: colors.textDim, flex: 'none' }}>{nf.t}</span>
                <span style={{ color: nf.c }}>{nf.m}</span>
              </div>
            ))}
            {!state.notifs.length && <div style={emptyStateStyle}>no alerts — reactor calm</div>}
          </div>
        )}
      </div>

      <div style={operatorChipStyle}>
        <div style={operatorAvatarStyle} />
        <div>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary }}>operator</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textMuted, marginTop: 3 }}>COMMAND DECK</div>
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  height: 60,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 22px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,16,24,.6)',
};
const logoWrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: 206 };
const logoDotStyle: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 44% 38%, #fff, #7ef0ff 32%, #17b8d8 66%)',
  boxShadow: '0 0 14px rgba(95,240,255,.85)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const logoTextStyle: CSSProperties = { font: `700 20px/1 ${fonts.ui}`, letterSpacing: 5, color: colors.textPrimary };
function tabStyle(on: boolean): CSSProperties {
  return {
    padding: '8px 15px',
    borderRadius: 8,
    font: `600 13px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    cursor: 'pointer',
    color: on ? colors.textPrimary : colors.textMuted,
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.35)' : '1px solid transparent',
  };
}
const opModeGroupStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  gap: 2,
  alignItems: 'center',
  marginRight: 12,
  padding: 3,
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
};
function opModeStyle(on: boolean, key: OpMode): CSSProperties {
  return {
    cursor: 'pointer',
    padding: '7px 11px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    whiteSpace: 'nowrap',
    transition: 'all .15s',
    color: on ? (key === 'AUTO' ? '#1a1204' : '#04202b') : colors.textMuted,
    background: on ? (key === 'AUTO' ? 'linear-gradient(180deg,#f5c66b,#d9a13f)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)') : undefined,
    boxShadow: on ? (key === 'AUTO' ? '0 0 12px rgba(245,198,107,.45)' : '0 0 12px rgba(95,220,255,.4)') : undefined,
    border: on ? undefined : '1px solid transparent',
  };
}
const iconButtonStyle: CSSProperties = {
  cursor: 'pointer',
  width: 36,
  height: 36,
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
  display: 'grid',
  placeItems: 'center',
  font: `700 14px/1 ${fonts.mono}`,
};
const apprBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: -4,
  right: -4,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: colors.warn,
  boxShadow: '0 0 10px rgba(245,198,107,.7)',
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: '#1a1204',
  padding: '0 4px',
};
const notifBadgeStyle: CSSProperties = {
  position: 'absolute',
  top: -7,
  right: -7,
  minWidth: 16,
  height: 16,
  borderRadius: 8,
  background: colors.danger,
  boxShadow: '0 0 10px rgba(255,107,122,.7)',
  display: 'grid',
  placeItems: 'center',
  font: `700 9px/1 ${fonts.mono}`,
  color: '#1a0508',
  padding: '0 4px',
};
const apprPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 0,
  width: 380,
  zIndex: 70,
  padding: 13,
  borderRadius: 12,
  border: '1px solid rgba(245,198,107,.4)',
  background: 'rgba(6,20,28,.98)',
  boxShadow: '0 20px 60px rgba(0,0,0,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const notifPanelStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 0,
  width: 320,
  zIndex: 70,
  padding: 12,
  borderRadius: 12,
  border: '1px solid rgba(95,220,255,.35)',
  background: 'rgba(6,20,28,.98)',
  boxShadow: '0 20px 60px rgba(0,0,0,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const panelTitleStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.warn };
const apprRowStyle: CSSProperties = {
  padding: '10px 11px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.2)',
  background: 'rgba(9,28,38,.7)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
function apprAvatarStyle(hue: string): CSSProperties {
  return {
    width: 22,
    height: 22,
    flex: 'none',
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 9px/1 ${fonts.mono}`,
    color: hue,
  };
}
const apprActionStyle: CSSProperties = { flex: 1, font: `600 12px/1.3 ${fonts.ui}`, color: colors.textPrimary };
function riskBadgeStyle(risk: 'HIGH' | 'MED' | 'LOW'): CSSProperties {
  const c = risk === 'HIGH' ? colors.danger : risk === 'MED' ? colors.warn : colors.success;
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '3px 6px', borderRadius: 4 };
}
const apprDetailStyle: CSSProperties = { font: `400 10px/1.5 ${fonts.mono}`, color: colors.textMuted };
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
const emptyStateStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim };
const operatorChipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 10px',
  borderRadius: 30,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
};
const operatorAvatarStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: 'repeating-linear-gradient(45deg,#0e3a48 0 5px,#12475a 5px 10px)',
  border: '1px solid rgba(95,220,255,.4)',
};
