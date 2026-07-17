import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

const NAV_ITEMS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings'];
const CLICKABLE = new Set(['Dashboard', 'Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Settings', 'Files', 'Uplinks']);
const RECENT_AGENTS = [
  { i: 'CB', label: 'Code Builder', ring: '#7ef0ff' },
  { i: 'UI', label: 'UI Designer', ring: '#8ab6ff' },
  { i: 'DB', label: 'Database Agent', ring: '#5fffe0' },
  { i: 'TR', label: 'Test Runner', ring: '#7fd8ef' },
];

export function Sidebar() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={rootStyle}>
      <div style={sectionLabelStyle}>NAVIGATION</div>
      {NAV_ITEMS.map((label) => {
        const on = label === state.activeTab;
        const clickable = CLICKABLE.has(label);
        return (
          <div
            key={label}
            onClick={clickable ? () => dispatch({ type: 'SET_ACTIVE_TAB', tab: label }) : undefined}
            style={navItemStyle(on, clickable)}
          >
            <span style={navDotWrapStyle(on)}>
              <span style={navDotStyle(on)} />
            </span>
            <span style={{ font: `600 14px/1 ${fonts.ui}`, letterSpacing: 1 }}>{label}</span>
          </div>
        );
      })}

      <div style={{ ...sectionLabelStyle, marginTop: 14 }}>RECENT AGENTS</div>
      {RECENT_AGENTS.map((r) => (
        <div key={r.i} style={recentRowStyle}>
          <span style={recentAvatarStyle(r.ring)}>{r.i}</span>
          <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{r.label}</span>
        </div>
      ))}

      <div style={tipCardStyle}>
        <div style={tipGlowStyle} />
        <div style={{ font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.accentCyanSoft }}>◇ REACTOR TIP</div>
        <div style={{ marginTop: 7, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textSecondary }}>
          Parallelize agents off one core to burn fewer tokens per task.
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = {
  width: 206,
  flex: 'none',
  padding: '18px 12px',
  borderRight: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(4,15,22,.55)',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  overflow: 'auto',
};
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim, padding: '2px 10px 6px' };
function navItemStyle(on: boolean, clickable: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    cursor: clickable ? 'pointer' : 'default',
    background: on ? 'linear-gradient(90deg, rgba(23,184,216,.18), rgba(23,184,216,.02))' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
    color: on ? colors.textPrimary : '#7f9fac',
    boxShadow: on ? 'inset 0 0 14px rgba(95,240,255,.12)' : undefined,
  };
}
function navDotWrapStyle(on: boolean): CSSProperties {
  return {
    width: 20,
    height: 20,
    borderRadius: 6,
    border: `1px solid ${on ? 'rgba(95,220,255,.6)' : 'rgba(80,140,160,.35)'}`,
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
  };
}
function navDotStyle(on: boolean): CSSProperties {
  return { width: 7, height: 7, borderRadius: 2, background: on ? colors.accentCyan : '#3d6572' };
}
const recentRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8 };
function recentAvatarStyle(ring: string): CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 6,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${ring}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: ring,
  };
}
const tipCardStyle: CSSProperties = {
  marginTop: 'auto',
  padding: 13,
  borderRadius: 12,
  border: '1px solid rgba(95,220,255,.25)',
  background: 'linear-gradient(180deg, rgba(14,48,60,.7), rgba(8,26,34,.7))',
  position: 'relative',
  overflow: 'hidden',
};
const tipGlowStyle: CSSProperties = {
  position: 'absolute',
  top: -14,
  right: -14,
  width: 56,
  height: 56,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(95,240,255,.25), transparent 70%)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
