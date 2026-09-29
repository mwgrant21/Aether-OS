import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { VIEWS } from '../../viewRegistry';
import { Reactor, reactorNativeSize } from '../reactor/Reactor';
import { computeSidebarReactorRate, computeSidebarReactorStatus, isSessionLive } from '../dashboard/dashboardMath';

const SIDEBAR_IDS = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
const REACTOR_MINI_SIZE = 150;
const IDLE_PULSE_IDS = new Set(['Terminal', 'Codex']);

export function Sidebar() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const live = isSessionLive(state, Date.now());
  const onDashboard = state.activeTab === 'Dashboard';
  return (
    <nav aria-label="Main" style={rootStyle(colors)}>
      <div style={scrollableNavStyle}>
        <div style={sectionLabelStyle(colors)}>NAVIGATION</div>
        <div data-testid="sidebar-nav" style={sidebarNavStyle}>
          {SIDEBAR_IDS.map((label) => {
            const on = label === state.activeTab;
            const idleFlag = label === 'Terminal' ? state.terminalIdle : label === 'Codex' ? state.codexTerminalIdle : false;
            // Gate on liveness too: a pty that exited only clears its pending idle
            // timer (see useTerminalIdleSync.ts's onExit handler), it never forces
            // idle back to false, so without this an exited pty's dot would keep
            // pulsing forever. terminalAlive/codexTerminalAlive disambiguate "quiet"
            // from "dead".
            const aliveFlag = label === 'Terminal' ? state.terminalAlive : label === 'Codex' ? state.codexTerminalAlive : false;
            const showIdlePulse = IDLE_PULSE_IDS.has(label) && idleFlag && aliveFlag && !on;
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
        {state.realAgents.slice(0, 4).map((a) => (
          <Button
            key={a.toolUseId}
            onClick={() => {
              dispatch({ type: 'SELECT_REAL_AGENT', toolUseId: a.toolUseId });
              dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
            }}
            style={recentRowStyle}
          >
            <span style={recentAvatarStyle(colors.accentCyanSoft)}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
            <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{a.subagentType}</span>
          </Button>
        ))}
        {!state.realAgents.length && <div style={{ font: `400 11px/1 ${fonts.ui}`, color: colors.textDim, padding: '2px 10px' }}>no active agents</div>}
      </div>

      {/* The Dashboard tab shows the full reactor already; two at once is
          redundant. visibility (not display/conditional render) keeps this
          box's height in the layout so the nav items above never jump when
          switching tabs. aria-live is NOT here on the wrapper -- it also
          holds the ticking rate line, canvas and legend, so putting it here
          would re-announce the whole block on every burn-rate tick AND on
          every tab switch (the visibility flip). It's scoped to just the
          status-line div below instead, the same pattern as TopBar's
          approvals/notifications counts. */}
      <div style={{ ...reactorMiniWrapStyle, visibility: onDashboard ? 'hidden' : 'visible' }}>
        <div style={reactorMiniScaleStyle}>
          {/* A same-size empty placeholder while on Dashboard, instead of
              <Reactor />, so this (invisible) sidebar copy stops animating --
              the Dashboard's own full-size reactor is the one actually
              shown, and running both canvases at once is wasted work. */}
          {onDashboard ? (
            <div style={reactorMiniPlaceholderStyle} />
          ) : (
            <div style={reactorMiniInnerStyle(reactorNativeSize(state.cfg.renderer))}>
              <Reactor />
            </div>
          )}
          {state.cfg.showReactorLegend && (
            <div style={reactorLegendStyle(colors)}>
              <div>HUE = MODEL</div>
              <div>PULSE = TOKENS/SEC</div>
              <div>TURBULENCE = CONCURRENCY</div>
              <div>CLARITY = CACHE HIT RATE</div>
            </div>
          )}
        </div>
        <div
          style={{
            font: `700 11px/1 ${fonts.mono}`,
            letterSpacing: 1,
            color: live ? colors.accentCyanSoft : colors.textMuted,
            textAlign: 'center',
            marginTop: 6,
          }}
        >
          REACTOR · {computeSidebarReactorRate(state, live)} TOK/MIN
        </div>
        <div
          data-testid="sidebar-reactor-status"
          aria-live="polite"
          style={{
            font: `400 11px/1.4 ${fonts.ui}`,
            color: live ? colors.textDim : colors.textMuted,
            textAlign: 'center',
            marginTop: 3,
          }}
        >
          {computeSidebarReactorStatus(live, state.realAgents.length)}
        </div>
      </div>
    </nav>
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
    minHeight: 0,
    overflow: 'hidden',
  };
}
// Nav + recent agents scroll internally so the reactor widget below always
// stays visible instead of being pushed off the bottom of the sidebar.
const scrollableNavStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};
const sidebarNavStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 };
function sectionLabelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim, padding: '2px 10px 6px' };
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
// Under prefers-reduced-motion: reduce, global.css's `*` rule collapses the
// idlePulse animation's duration to near-zero -- the dot still turns amber,
// it just stops visibly pulsing. That static-amber degradation is accepted
// behavior, not a bug.
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
    font: `700 11px/1 ${fonts.mono}`,
    color: ring,
  };
}
const reactorMiniWrapStyle: CSSProperties = {
  flex: 'none',
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
// Stands in for <Reactor /> on the Dashboard tab: fills the same
// reactorMiniScaleStyle box (no transform/centering math needed, since
// there's no native reactor size to center) so the box's footprint is
// identical either way.
const reactorMiniPlaceholderStyle: CSSProperties = { width: '100%', height: '100%' };
function reactorLegendStyle(colors: ColorPalette): CSSProperties {
  return {
    position: 'absolute',
    left: 4,
    bottom: 2,
    padding: '5px 7px',
    borderRadius: 6,
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    font: `600 11px/1.5 ${fonts.mono}`,
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
