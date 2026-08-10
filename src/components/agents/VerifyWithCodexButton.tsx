import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';
import { useCrossEngineSync } from '../../state/useCrossEngineSync';

const PHASE_LABEL: Record<string, string> = {
  'preparing-evidence': 'Preparing evidence…',
  'creating-snapshot': 'Creating snapshot…',
  'checking-auth': 'Checking auth…',
  verifying: 'Verifying…',
  'running-tests': 'Running tests…',
};

export function VerifyWithCodexButton({ toolUseId, evidenceSufficient }: { toolUseId: string; evidenceSufficient: boolean }) {
  const colors = useColors();
  const { state } = useAetherStore();
  const { state: runState, start, cancel, reset } = useCrossEngineSync();

  const running = runState.status === 'running';

  const disabledReason = !state.crossEngineCfg.enabled
    ? 'Cross-engine verification is off'
    : !evidenceSufficient
      ? 'Evidence unavailable for this dispatch'
      : running
        ? 'A verification is already running'
        : null;

  const run = async () => {
    await start(toolUseId);
  };

  if (runState.status === 'running') {
    return (
      <div style={wrapStyle(colors)}>
        <span style={statusTextStyle(colors)}>{PHASE_LABEL[runState.phase] ?? 'Verifying…'}</span>
        <Button onClick={cancel} style={cancelStyle(colors)}>
          CANCEL
        </Button>
      </div>
    );
  }

  if (runState.status === 'done') {
    const { result } = runState;
    return (
      <div style={wrapStyle(colors)}>
        <div style={resultHeaderStyle(colors, result.verdict)}>
          {result.verdict.toUpperCase()} · {Math.round(result.confidence * 100)}% confidence
        </div>
        <p style={summaryTextStyle(colors)}>{result.summary}</p>
        {result.findings.length > 0 && (
          <ul style={findingsListStyle}>
            {result.findings.map((f, i) => (
              <li key={i} style={findingItemStyle(colors, f.severity)}>
                <span>{f.claim}</span>
                {f.file && (
                  <span style={findingLocationStyle(colors)}>
                    {' '}
                    ({f.file}
                    {f.line !== null ? `:${f.line}` : ''})
                  </span>
                )}
                <div style={evidenceTextStyle(colors)}>{f.evidence}</div>
              </li>
            ))}
          </ul>
        )}
        {result.tests.length > 0 && (
          <ul style={findingsListStyle}>
            {result.tests.map((t, i) => (
              <li key={i} style={findingItemStyle(colors, t.outcome === 'failed' ? 'error' : 'info')}>
                <code>{t.command}</code> — {t.outcome}
                {t.detail && <div style={evidenceTextStyle(colors)}>{t.detail}</div>}
              </li>
            ))}
          </ul>
        )}
        {result.limitations.length > 0 && (
          <p style={summaryTextStyle(colors)}>Limitations: {result.limitations.join('; ')}</p>
        )}
        <Button onClick={reset} style={buttonStyle(colors, true)}>
          DISMISS
        </Button>
      </div>
    );
  }

  if (runState.status === 'error') {
    return (
      <div style={wrapStyle(colors)}>
        <div style={errorTextStyle()}>
          Verification failed ({runState.code}): {runState.message}
        </div>
        <Button onClick={reset} style={buttonStyle(colors, true)}>
          DISMISS
        </Button>
      </div>
    );
  }

  if (runState.status === 'cancelled') {
    return (
      <div style={wrapStyle(colors)}>
        <span style={statusTextStyle(colors)}>Verification cancelled</span>
        <Button onClick={reset} style={buttonStyle(colors, true)}>
          DISMISS
        </Button>
      </div>
    );
  }

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

function wrapStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: 'rgba(10,32,43,.4)',
    maxWidth: 360,
  };
}
function statusTextStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1.3 ${fonts.ui}`, color: colors.textSecondary };
}
function cancelStyle(colors: ColorPalette): CSSProperties {
  return { ...buttonStyle(colors, true), alignSelf: 'flex-start', background: 'rgba(10,32,43,.6)', color: colors.textMuted, border: `1px solid ${colors.chipBorder}` };
}
function resultHeaderStyle(colors: ColorPalette, verdict: string): CSSProperties {
  const color = verdict === 'supported' ? '#7ef0ff' : verdict === 'contradicted' ? '#ff6b6b' : colors.textMuted;
  return { font: `700 11px/1.2 ${fonts.ui}`, letterSpacing: 1, color };
}
function summaryTextStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textSecondary };
}
const findingsListStyle: CSSProperties = { margin: 0, padding: '0 0 0 14px', display: 'flex', flexDirection: 'column', gap: 4 };
function findingItemStyle(colors: ColorPalette, severity: string): CSSProperties {
  const color = severity === 'error' ? '#ff6b6b' : severity === 'warning' ? '#ffcf6b' : colors.textSecondary;
  return { font: `500 11px/1.3 ${fonts.ui}`, color };
}
function findingLocationStyle(colors: ColorPalette): CSSProperties {
  return { font: `500 10px/1 ${fonts.mono}`, color: colors.textMuted };
}
function evidenceTextStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 10px/1.3 ${fonts.mono}`, color: colors.textMuted };
}
function errorTextStyle(): CSSProperties {
  return { font: `500 11px/1.4 ${fonts.ui}`, color: '#ff6b6b' };
}
