import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { SystemOverviewCard } from './SystemOverviewCard';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';
import { PtyTerminal } from './PtyTerminal';

export function TerminalView() {
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
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
