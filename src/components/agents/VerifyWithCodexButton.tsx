import { useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';

export function VerifyWithCodexButton({ toolUseId, evidenceSufficient }: { toolUseId: string; evidenceSufficient: boolean }) {
  const colors = useColors();
  const { state } = useAetherStore();
  const [running, setRunning] = useState(false);

  const disabledReason = !state.crossEngineCfg.enabled
    ? 'Cross-engine verification is off'
    : !evidenceSufficient
      ? 'Evidence unavailable for this dispatch'
      : running
        ? 'A verification is already running'
        : null;

  const run = async () => {
    setRunning(true);
    try {
      await window.aetherElectron?.crossEngine?.verifyDispatch(toolUseId);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button onClick={run} disabled={disabledReason !== null} title={disabledReason ?? undefined} style={buttonStyle(colors, disabledReason === null)}>
      VERIFY WITH CODEX
    </Button>
  );
}

function buttonStyle(colors: ColorPalette, enabled: boolean): CSSProperties {
  return {
    padding: '5px 10px',
    borderRadius: 6,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    cursor: enabled ? 'pointer' : 'not-allowed',
    color: enabled ? '#04202b' : colors.textMuted,
    background: enabled ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    border: enabled ? 'none' : `1px solid ${colors.chipBorder}`,
    opacity: enabled ? 1 : 0.6,
  };
}
