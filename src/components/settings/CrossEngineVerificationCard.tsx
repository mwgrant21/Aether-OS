import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';
import type { VerifierStatus } from '../../shared/crossEngineTypes';

const DISCLOSURE =
  'Sends the selected verification snapshot to OpenAI Codex. Uses your ChatGPT Codex allowance. OpenAI API billing is disabled. OpenAI API keys and custom gateways are blocked. No automatic fallback.';

export function CrossEngineVerificationCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { enabled } = state.crossEngineCfg;
  const [status, setStatus] = useState<VerifierStatus>('disabled');
  const [confirming, setConfirming] = useState(false);

  // Push the persisted preference to main on every mount (covers app restart,
  // where main.ts always starts with its own default until told otherwise)
  // and on every toggle -- same pattern as OperatingModeCard's autoHeadlines
  // push, since main.ts has no visibility into localStorage-persisted state.
  useEffect(() => {
    window.aetherElectron?.crossEngine?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setStatus('disabled');
      return;
    }
    window.aetherElectron?.crossEngine?.status().then(setStatus);
  }, [enabled]);

  const toggle = () => {
    if (!enabled) {
      setConfirming(true);
      return;
    }
    dispatch({ type: 'SET_CROSS_ENGINE_CFG', cfg: { enabled: false, provider: 'codex-chatgpt' } });
  };

  const confirmEnable = () => {
    setConfirming(false);
    dispatch({ type: 'SET_CROSS_ENGINE_CFG', cfg: { enabled: true, provider: 'codex-chatgpt' } });
  };

  const connect = async () => {
    const result = await window.aetherElectron?.crossEngine?.connectCodexSubscription();
    if (result) setStatus(result);
  };

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>CROSS-ENGINE VERIFICATION</div>
        <Button onClick={toggle} style={toggleStyle(colors, enabled)}>
          {enabled ? 'DISABLE' : 'ENABLE'}
        </Button>
      </div>

      {confirming && (
        <div style={confirmWrapStyle(colors)}>
          <p style={disclosureStyle(colors)}>{DISCLOSURE}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button onClick={confirmEnable} style={toggleStyle(colors, true)}>
              I UNDERSTAND, ENABLE
            </Button>
            <Button onClick={() => setConfirming(false)} style={toggleStyle(colors, false)}>
              CANCEL
            </Button>
          </div>
        </div>
      )}

      {enabled && (
        <>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>PROVIDER</div>
            <div style={valueStyle(colors)}>CODEX VIA CHATGPT</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>BILLING</div>
            <div style={valueStyle(colors)}>SUBSCRIPTION ONLY</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>STATUS</div>
            <div style={valueStyle(colors)}>{status.toUpperCase()}</div>
          </div>
          <Button onClick={connect} style={{ ...toggleStyle(colors, false), marginTop: 10 }}>
            {status === 'ready-subscription' ? 'RECONNECT' : 'CONNECT CHATGPT'}
          </Button>
          <p style={hintStyle(colors)}>{DISCLOSURE}</p>
        </>
      )}
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function confirmWrapStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: 'rgba(10,32,43,.4)',
  };
}
function disclosureStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
function rowStyle(_colors: ColorPalette): CSSProperties {
  return { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
