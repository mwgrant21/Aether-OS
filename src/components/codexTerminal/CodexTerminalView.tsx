import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { PtyCodexTerminal } from './PtyCodexTerminal';

export function CodexTerminalView() {
  const colors = useColors();
  const { state } = useAetherStore();

  // The pty must never spawn for an operator who hasn't opted in -- gating
  // here (before PtyCodexTerminal ever mounts) means the codexPty:start IPC
  // call in PtyCodexTerminal's getOrCreateHost is never reached while
  // disabled, even if the operator navigates to this tab.
  if (!state.codexTerminalCfg.enabled) {
    return (
      <div style={rootStyle}>
        <div style={disabledCardStyle(colors)}>Codex terminal is disabled — enable it in Settings first.</div>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle(colors)}>
        <div style={headerStyle(colors)}>
          <span style={liveDotStyle(colors)} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@codex</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>CODEX TERMINAL</span>
        </div>
        <div style={termHostStyle}>
          <PtyCodexTerminal />
        </div>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex' };
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
function liveDotStyle(colors: ColorPalette): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
}
const termHostStyle: CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
function disabledCardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    font: `400 13px/1.5 ${fonts.mono}`,
    color: colors.textDim,
    textAlign: 'center',
    padding: 20,
  };
}
