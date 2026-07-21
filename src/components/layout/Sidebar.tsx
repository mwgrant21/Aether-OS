import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { VIEWS } from '../../viewRegistry';
import { ReactorCore } from '../reactor/ReactorCore';
import { short } from '../../utils/format';

const SIDEBAR_IDS = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
const REACTOR_NATIVE_SIZE = 334;
const REACTOR_MINI_SIZE = 150;
const REACTOR_MINI_SCALE = REACTOR_MINI_SIZE / REACTOR_NATIVE_SIZE;

export function Sidebar() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={rootStyle}>
      <div style={sectionLabelStyle}>NAVIGATION</div>
      {SIDEBAR_IDS.map((label) => {
        const on = label === state.activeTab;
        return (
          <div key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={navItemStyle(on)}>
            <span style={navDotWrapStyle(on)}>
              <span style={navDotStyle(on)} />
            </span>
            <span style={{ font: `600 14px/1 ${fonts.ui}`, letterSpacing: 1 }}>{label}</span>
          </div>
        );
      })}

      <div style={{ ...sectionLabelStyle, marginTop: 14 }}>RECENT AGENTS</div>
      {state.agents.slice(0, 4).map((a) => (
        <div
          key={a.name}
          onClick={() => {
            dispatch({ type: 'SELECT_AGENT', name: a.name });
            dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
          }}
          style={recentRowStyle}
        >
          <span style={recentAvatarStyle(a.hue)}>{a.i}</span>
          <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{a.name}</span>
        </div>
      ))}
      {!state.agents.length && <div style={{ font: `400 11px/1 ${fonts.ui}`, color: colors.textDim, padding: '2px 10px' }}>no active agents</div>}

      <div style={reactorMiniWrapStyle}>
        <div style={reactorMiniScaleStyle}>
          <div style={reactorMiniInnerStyle}>
            <ReactorCore />
          </div>
        </div>
        <div style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: 1, color: colors.accentCyanSoft, textAlign: 'center', marginTop: 6 }}>
          REACTOR · {short(state.rate)} TOK/MIN
        </div>
        <div style={{ font: `400 10px/1.4 ${fonts.ui}`, color: colors.textDim, textAlign: 'center', marginTop: 3 }}>
          Reactor nominal — {state.agents.length} agents drawing power.
        </div>
      </div>

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
function navItemStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    cursor: 'pointer',
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
const recentRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, cursor: 'pointer' };
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
const reactorMiniWrapStyle: CSSProperties = {
  marginTop: 10,
  padding: '10px 0',
  borderRadius: 12,
  background: 'radial-gradient(closest-side, rgba(10,34,45,.55), transparent)',
};
const reactorMiniScaleStyle: CSSProperties = {
  position: 'relative',
  width: REACTOR_MINI_SIZE,
  height: REACTOR_MINI_SIZE,
  margin: '0 auto',
  overflow: 'hidden',
};
const reactorMiniInnerStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: REACTOR_NATIVE_SIZE,
  height: REACTOR_NATIVE_SIZE,
  // ReactorCore's own canvases don't all self-center: the conduit layer has
  // explicit inset:0, but the glow/core layers have no offsets at all and
  // rely on their parent being a `display:grid; placeItems:center` container
  // (exactly what TerminalView's original wrapper was) to center them. Drop
  // this and two of the three layers drift from the conduit layer.
  display: 'grid',
  placeItems: 'center',
  transform: `translate(-50%, -50%) scale(${REACTOR_MINI_SCALE})`,
};
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
