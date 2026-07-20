import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { SystemOverviewCard } from './SystemOverviewCard';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';
import { ReactorCore } from '../reactor/ReactorCore';
import { PtyTerminal } from './PtyTerminal';

export function TerminalView() {
  const { state } = useAetherStore();

  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle}>
        <div style={scanSweepStyle} />
        <div style={headerStyle}>
          <span style={liveDotStyle} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@aether-core</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>TERMINAL · zsh</span>
        </div>

        <div style={termHostStyle}>
          <PtyTerminal />
        </div>

        <div style={coreFloatWrapStyle}>
          <ReactorCore />
        </div>
        <div style={calloutStyle}>Reactor nominal — {state.agents.length} agents drawing power.</div>
      </div>

      <div style={railStyle}>
        <SystemOverviewCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const terminalCardStyle: CSSProperties = {
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
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 16px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
const liveDotStyle: CSSProperties = { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
const termHostStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
const coreFloatWrapStyle: CSSProperties = {
  position: 'absolute',
  right: 6,
  top: '52%',
  transform: 'translateY(-50%)',
  width: 334,
  height: 334,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
};
const calloutStyle: CSSProperties = {
  position: 'absolute',
  right: 100,
  top: 'calc(52% + 176px)',
  padding: '9px 13px',
  borderRadius: '2px 10px 10px 10px',
  border: '1px solid rgba(95,220,255,.3)',
  background: 'rgba(10,34,45,.9)',
  font: `400 12px/1.4 ${fonts.ui}`,
  color: '#bff4ff',
  maxWidth: 146,
  textAlign: 'left',
};
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
