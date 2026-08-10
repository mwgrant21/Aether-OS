import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { VIEWS } from '../../viewRegistry';
import { Reactor, reactorNativeSize } from '../reactor/Reactor';
import { short } from '../../utils/format';

const SIDEBAR_IDS = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
const REACTOR_MINI_SIZE = 150;
const IDLE_PULSE_IDS = new Set(['Terminal', 'Codex']);

export function Sidebar() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  return (
    <div style={rootStyle(colors)}>
      <div style={sectionLabelStyle(colors)}>NAVIGATION</div>
      <div data-testid="sidebar-nav" style={sidebarNavStyle}>
        {SIDEBAR_IDS.map((label) => {
          const on = label === state.activeTab;
          const idleFlag = label === 'Terminal' ? state.terminalIdle : label === 'Codex' ? state.codexTerminalIdle : false;
          const showIdlePulse = IDLE_PULSE_IDS.has(label) && idleFlag && !on;
          return (
            <Button key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={navItemStyle(colors, on)}>
              <span style={navDotWrapStyle(on)}>
                <span style={navDotStyle(colors, on, showIdlePulse)} data-idle-pulse={showIdlePulse ? 'true' : undefined} />
              </span>
              <span style={{ font: `600 14px/1 ${fonts.ui}`, letterSpacing: 1 }}>{label}</span>
            </Button>
          );
        })}
      </div>

      <div style={{ ...sectionLabelStyle(colors), marginTop: 14 }}>RECENT AGENTS</div>
      {state.agents.slice(0, 4).map((a) => (
        <Button
          key={a.name}
          onClick={() => {
            dispatch({ type: 'SELECT_AGENT', name: a.name });
            dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
          }}
          style={recentRowStyle}
        >
          <span style={recentAvatarStyle(a.hue)}>{a.i}</span>
          <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{a.name}</span>
        </Button>
      ))}
      {!state.agents.length && <div style={{ font: `400 11px/1 ${fonts.ui}`, color: colors.textDim, padding: '2px 10px' }}>no active agents</div>}

      <div style={reactorMiniWrapStyle}>
        <div style={reactorMiniScaleStyle}>
          <div style={reactorMiniInnerStyle(reactorNativeSize(state.cfg.renderer))}>
            <Reactor />
          </div>
          {state.cfg.showReactorLegend && (
            <div style={reactorLegendStyle(colors)}>
              <div>HUE = MODEL</div>
              <div>PULSE = TOKENS/SEC</div>
              <div>TURBULENCE = CONCURRENCY</div>
              <div>CLARITY = CACHE HIT RATE</div>
            </div>
          )}
        </div>
        <div style={{ font: `700 11px/1 ${fonts.mono}`, letterSpacing: 1, color: colors.accentCyanSoft, textAlign: 'center', marginTop: 6 }}>
          REACTOR · {short(state.rate)} TOK/MIN
        </div>
        <div style={{ font: `400 10px/1.4 ${fonts.ui}`, color: colors.textDim, textAlign: 'center', marginTop: 3 }}>
          Reactor nominal — {state.realAgents.length} agents drawing power.
        </div>
      </div>
    </div>
  );
}

function rootStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
const sidebarNavStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
function sectionLabelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim, padding: '2px 10px 6px' };
}
function navItemStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'linear-gradient(90deg, rgba(23,184,216,.18), rgba(23,184,216,.02))' : colors.panelInset,
    border: on ? '1px solid rgba(95,220,255,.4)' : `1px solid ${colors.chipBorder}`,
    color: on ? colors.textPrimary : colors.textMuted,
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
function navDotStyle(colors: ColorPalette, on: boolean, idlePulse = false): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: 2,
    background: idlePulse ? '#ffb020' : on ? colors.accentCyan : '#3d6572',
    animation: idlePulse ? 'idlePulse 1.6s ease-in-out infinite' : undefined,
  };
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
function reactorLegendStyle(colors: ColorPalette): CSSProperties {
  return {
    position: 'absolute',
    left: 4,
    bottom: 2,
    padding: '5px 7px',
    borderRadius: 6,
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    font: `600 8px/1.5 ${fonts.mono}`,
    letterSpacing: 0.5,
    color: colors.accentCyanSoft,
    pointerEvents: 'none',
  };
}
function reactorMiniInnerStyle([nativeWidth, nativeHeight]: [number, number]): CSSProperties {
  const scale = REACTOR_MINI_SIZE / Math.max(nativeWidth, nativeHeight);
  return {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: nativeWidth,
    height: nativeHeight,
    // ReactorCore's own canvases don't all self-center: the conduit layer has
    // explicit inset:0, but the glow/core layers have no offsets at all and
    // rely on their parent being a `display:grid; placeItems:center` container
    // (exactly what TerminalView's original wrapper was) to center them. Drop
    // this and two of the three layers drift from the conduit layer.
    // StormCore centers itself the same way, so this wrapper works for both.
    display: 'grid',
    placeItems: 'center',
    transform: `translate(-50%, -50%) scale(${scale})`,
  };
}
