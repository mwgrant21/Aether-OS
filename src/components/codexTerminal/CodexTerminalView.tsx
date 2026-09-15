import { useEffect, useState, type CSSProperties } from 'react';
import type { CodexLaunchInfo } from '../../../electron/codexLaunchInfo';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { PtyCodexTerminal } from './PtyCodexTerminal';

export function CodexTerminalView() {
  const colors = useColors();
  const { state } = useAetherStore();
  const enabled = state.codexTerminalCfg.enabled;

  // Which `codex` this terminal launches (answered by a profile-loaded shell
  // running the terminal's own selection on its filtered launch env, see
  // electron/codexLaunchInfo.ts). Pull-based like
  // useTranscriptSource: fetched once per enable, held in view state only,
  // never dispatched into the store. It describes the NEXT launch -- an
  // already-running session keeps whatever version it started with.
  const [launch, setLaunch] = useState<CodexLaunchInfo | null>(null);
  useEffect(() => {
    // Browser-only `npm run dev` has no preload bridge: leave the readout at
    // its resolving placeholder rather than throwing (PtyCodexTerminal makes
    // the same no-bridge check before it tries to start a pty).
    const api = window.aetherElectron;
    if (!enabled || !api) return;
    let live = true;
    api.codexPty.launchInfo().then((info) => {
      if (live) setLaunch(info);
    });
    return () => {
      live = false;
    };
  }, [enabled]);

  // The pty must never spawn for an operator who hasn't opted in -- gating
  // here (before PtyCodexTerminal ever mounts) means the codexPty:start IPC
  // call in PtyCodexTerminal's getOrCreateHost is never reached while
  // disabled, even if the operator navigates to this tab.
  if (!enabled) {
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
          <span
            title={launch?.executable ?? undefined}
            style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: launch?.error ? colors.warn : colors.textDim }}
          >
            {launch === null ? 'resolving codex…' : (launch.version ?? launch.error)}
          </span>
          <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>CODEX TERMINAL</span>
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
