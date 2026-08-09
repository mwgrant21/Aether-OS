import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, space, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { VerifierStatus } from '../../shared/crossEngineTypes';

// Uplinks used to render 3 hardcoded fake "providers" you could toggle
// on/off, plus a "DEFAULT RUNTIME" picker implying Aether routes work
// between providers. Neither was real: this app only observes its own
// embedded terminal and (via Cross-Engine Verification, see
// CrossEngineVerificationCard.tsx) can manually trigger one Codex
// verification -- there is no runtime-routing concept to default. This view
// now renders exactly two rows, both backed by real state:
//   - Aether Core: the embedded terminal's pty liveness (state.terminalAlive,
//     kept live by useTerminalAliveSync). Not a toggle -- you can't
//     "connect"/"disconnect" your own terminal, only observe whether it's
//     still running.
//   - OpenAI/Codex: the same crossEngine connection CrossEngineVerificationCard
//     drives (window.aetherElectron.crossEngine), so both surfaces always
//     agree -- there is exactly one Codex connection, not two.
export function UplinksView() {
  const colors = useColors();
  const { state } = useAetherStore();
  const { enabled } = state.crossEngineCfg;
  const [codexStatus, setCodexStatus] = useState<VerifierStatus>('disabled');

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

  const connectCodex = async () => {
    const result = await window.aetherElectron?.crossEngine?.connectCodexSubscription();
    if (result) setCodexStatus(result);
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

        <div style={rowStyle(colors, codexOnline)}>
          <span style={dotStyle(colors, codexOnline)} />
          <span style={nameStyle(colors)}>OpenAI/Codex</span>
          <span style={badgeStyle(colors, codexOnline)}>{codexOnline ? 'ONLINE' : 'OFFLINE'}</span>
          {enabled ? (
            <Button onClick={connectCodex} style={toggleButtonStyle(colors, codexOnline)}>
              {codexOnline ? 'RECONNECT' : 'CONNECT'}
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
