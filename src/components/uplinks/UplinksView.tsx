import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, space, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { VerifierStatus } from '../../shared/crossEngineTypes';

// Uplinks used to render 3 hardcoded fake "providers" you could toggle
// on/off, plus a "DEFAULT RUNTIME" picker implying Aether routes work
// between providers. Neither was real: this app now observes two independent
// embedded terminals (Claude and, since the Codex terminal view shipped,
// Codex too) and, via Cross-Engine Verification (see
// CrossEngineVerificationCard.tsx), can manually trigger one Codex
// verification -- there is no runtime-routing concept to default. This view
// now renders exactly three rows, all backed by real state:
//   - Aether Core: the embedded Claude terminal's pty liveness
//     (state.terminalAlive, kept live by useTerminalAliveSync). Not a
//     toggle -- you can't "connect"/"disconnect" your own terminal, only
//     observe whether it's still running.
//   - Codex Terminal: the independent Codex terminal pty's own liveness
//     (state.codexTerminalAlive, kept live by useCodexTerminalAliveSync) --
//     a separate signal from the row below, never merged with it, because
//     the Codex terminal pty and the cross-engine verifier's connection are
//     two structurally different things that happen to share a vendor.
//   - OpenAI/Codex: the same crossEngine connection CrossEngineVerificationCard
//     drives (window.aetherElectron.crossEngine), so both surfaces always
//     agree -- there is exactly one Codex verifier connection, not two.
export function UplinksView() {
  const colors = useColors();
  const { state } = useAetherStore();
  const { enabled } = state.crossEngineCfg;
  const [codexStatus, setCodexStatus] = useState<VerifierStatus>('disabled');
  const [connecting, setConnecting] = useState(false);

  // Push the persisted preference to main on every mount and on every toggle,
  // same as CrossEngineVerificationCard.tsx -- main.ts's crossEngineFeatureEnabled
  // flag is in-memory only and always starts false on launch, so whichever
  // surface (Settings or Uplinks) mounts first must sync it. Without this,
  // an operator who enabled cross-engine verification in a prior session and
  // navigates straight to Uplinks in a fresh session sees a stale 'disabled'
  // status from main while this view's own `enabled` check still thinks it's on.
  useEffect(() => {
    window.aetherElectron?.crossEngine?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setCodexStatus('disabled');
      return;
    }
    window.aetherElectron?.crossEngine
      ?.status()
      .then(setCodexStatus)
      .catch(() => setCodexStatus('error'));
  }, [enabled]);

  const codexOnline = codexStatus === 'ready-subscription';

  // Mirrors CrossEngineVerificationCard.tsx: this is the real ChatGPT login and
  // can block for minutes on a browser OAuth flow, so the button has to show
  // that something is in flight rather than looking dead.
  const connectCodex = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const result = await window.aetherElectron?.crossEngine?.connectCodexSubscription();
      if (result) setCodexStatus(result);
    } catch {
      // Defense in depth: even with setEnabled synced above, any other
      // failure down this call chain (e.g. main's assertCrossEngineFeatureEnabled
      // guard throwing) must not surface as an unhandled promise rejection.
      setCodexStatus('error');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>UPLINKS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, marginTop: space.md }}>
        <div style={rowStyle(colors, state.terminalAlive)}>
          <span style={dotStyle(colors, state.terminalAlive)} />
          <span style={nameStyle(colors)}>Aether Core</span>
          <span style={badgeStyle(colors, state.terminalAlive)}>{state.terminalAlive ? 'ONLINE' : 'OFFLINE'}</span>
        </div>

        <div style={rowStyle(colors, state.codexTerminalAlive)}>
          <span style={dotStyle(colors, state.codexTerminalAlive)} />
          <span style={nameStyle(colors)}>Codex Terminal</span>
          <span style={badgeStyle(colors, state.codexTerminalAlive)}>
            {state.codexTerminalAlive ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>

        <div style={rowStyle(colors, codexOnline)}>
          <span style={dotStyle(colors, codexOnline)} />
          <span style={nameStyle(colors)}>OpenAI/Codex</span>
          <span style={badgeStyle(colors, codexOnline)}>{codexOnline ? 'ONLINE' : 'OFFLINE'}</span>
          {enabled ? (
            <Button onClick={connectCodex} disabled={connecting} style={toggleButtonStyle(colors, codexOnline)}>
              {connecting ? 'CONNECTING...' : codexOnline ? 'RECONNECT' : 'CONNECT'}
            </Button>
          ) : (
            <Button
              onClick={() => undefined}
              disabled
              title="Enable Cross-Engine Verification in Settings first"
              style={disabledButtonStyle(colors)}
            >
              ENABLE IN SETTINGS
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 18,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function rowStyle(colors: ColorPalette, online: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 9,
    border: '1px solid rgba(80,190,220,.16)',
    background: colors.panelInset,
    opacity: online ? 1 : 0.55,
  };
}
function dotStyle(colors: ColorPalette, online: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: 'none',
    background: online ? colors.success : colors.textDim,
    boxShadow: online ? '0 0 8px rgba(59,224,160,.8)' : undefined,
  };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function badgeStyle(colors: ColorPalette, online: boolean): CSSProperties {
  const c = online ? colors.success : colors.textDim;
  return { flex: 'none', font: `600 9px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 8px', borderRadius: 4 };
}
function disabledButtonStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    cursor: 'not-allowed',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '6px 12px',
    borderRadius: 7,
    color: colors.textMuted,
    background: 'rgba(10,32,43,.6)',
    border: '1px solid rgba(80,190,220,.25)',
  };
}
function toggleButtonStyle(colors: ColorPalette, online: boolean): CSSProperties {
  return {
    flex: 'none',
    cursor: 'pointer',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '6px 12px',
    borderRadius: 7,
    color: online ? colors.dangerSoft : '#04202b',
    background: online ? 'rgba(255,90,90,.06)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
    border: online ? '1px solid rgba(255,120,120,.4)' : 'none',
    boxShadow: online ? undefined : '0 0 10px rgba(95,220,255,.4)',
  };
}
