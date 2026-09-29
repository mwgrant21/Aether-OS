import type { CSSProperties } from 'react';
import { fonts, glows, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { isSessionLive } from '../dashboard/dashboardMath';
import { useColors } from '../shared/useColors';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';
import { PlanUsageCard } from './PlanUsageCard';
import { PtyTerminal } from './PtyTerminal';
import { CommunicationClientStatus } from './CommunicationClientStatus';
import { Button } from '../shared/Button';
import { useCrossCheckComposer } from './CrossCheckComposer';

export function TerminalView() {
  const colors = useColors();
  const composer = useCrossCheckComposer();
  const { state } = useAetherStore();
  // Same signal as the dashboard: an open pty is a shell, not a Claude session.
  const live = isSessionLive(state, Date.now());
  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle(colors)}>
        <div style={scanSweepStyle} />
        <div style={headerStyle(colors)}>
          <span data-testid="terminal-session-dot" style={liveDotStyle(colors, live)} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@aether-core</span>
          <span data-testid="terminal-session-status" style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>
            :~$ {live ? 'session active' : 'standby'}
          </span>
          <Button onClick={composer.open} style={{ marginLeft: 'auto', padding: '5px 8px', borderRadius: 6,
            border: `1px solid ${colors.panelBorder}`, color: colors.accentCyanSoft, font: `400 11px/1 ${fonts.mono}` }}>
            Cross-check with Codex
          </Button>
          <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>TERMINAL · zsh</span>
        </div>

        <CommunicationClientStatus inTerminal />
        <div style={termHostStyle}>
          <PtyTerminal />
        </div>
      </div>

      <div style={railStyle}>
        <PlanUsageCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
function terminalCardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  };
}
const scanSweepStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 150,
  background: 'linear-gradient(180deg, rgba(95,240,255,.08), transparent)',
  animation: 'scan 7s linear infinite',
  pointerEvents: 'none',
};
function headerStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 16px',
    borderBottom: `1px solid ${colors.chromeBorder}`,
  };
}
// Glow-Is-State: lit only while a session is live; flat and muted at standby.
function liveDotStyle(colors: ColorPalette, live: boolean): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: live ? colors.accentCyanDeep : colors.textMuted, boxShadow: live ? glows.hot : undefined };
}
const termHostStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
