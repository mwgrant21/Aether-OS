import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { ModelPolicyMode } from '../../shared/modelPolicy';

const MODES: ModelPolicyMode[] = ['Local', 'API', 'Off'];

const COPY: Record<ModelPolicyMode, string> = {
  Local: 'Local · no model calls yet (Stage 12 adds on-device detection)',
  API: 'API · Chat and headlines call Anthropic, billed to your key',
  Off: 'Off · no model calls, ever',
};

type SpendInfo = { monthTotalUsd: number; gate: 'ok' | 'degrade' | 'blocked' };

const GATE_WARNING: Partial<Record<SpendInfo['gate'], string>> = {
  degrade: 'Approaching the monthly ceiling',
  blocked: 'Monthly ceiling reached — no further calls this month',
};

export function ModelPolicyCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { modelPolicyMode } = state.cfg;
  const [spend, setSpend] = useState<SpendInfo | null>(null);

  // Push the persisted preference to main on every mount and on every
  // change -- same pattern as ChatBackendCard's autoHeadlines effect, for
  // the same reason: main.ts always starts with its own default until told.
  useEffect(() => {
    window.aetherElectron?.agents.setModelPolicyMode(modelPolicyMode);
  }, [modelPolicyMode]);

  // Fetch-on-mount plus fetch-after-mode-change is enough for a live signal
  // here -- continuous polling is deliberately out of scope (see finding 6).
  useEffect(() => {
    window.aetherElectron?.agents.getModelSpend().then(setSpend).catch(() => setSpend(null));
  }, [modelPolicyMode]);

  const warning = spend ? GATE_WARNING[spend.gate] : undefined;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>MODEL POLICY</div>
      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        {MODES.map((mode) => (
          <Button
            key={mode}
            onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { modelPolicyMode: mode } })}
            style={modeButtonStyle(colors, mode === modelPolicyMode)}
          >
            {mode.toUpperCase()}
          </Button>
        ))}
      </div>
      <div style={hintStyle(colors)}>{COPY[modelPolicyMode]}</div>
      {spend && <div style={hintStyle(colors)}>${spend.monthTotalUsd.toFixed(2)} spent this month</div>}
      {warning && <div style={warningStyle(colors)}>{warning}</div>}
      <div style={hintStyle(colors)}>
        Once the monthly ceiling is reached, no further calls are made — Aether can see what it has spent, never your account balance.
      </div>
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
function modeButtonStyle(colors: ColorPalette, active: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: active ? '#04202b' : colors.textMuted,
    background: active ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: active ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: active ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `500 11px/1.4 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
function warningStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `600 11px/1.4 ${fonts.ui}`,
    color: colors.danger,
  };
}
