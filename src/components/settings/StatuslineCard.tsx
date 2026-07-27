import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';

type InstallStatus = 'installed' | 'installed-other' | 'not-installed' | 'unreadable';
interface StatuslineState {
  status: InstallStatus;
  existingCommand: string | null;
  settingsPath: string;
  scriptPath: string;
}
type ActionResult = { ok: boolean; backupPath?: string | null; error?: string };

const STATUS_COPY: Record<InstallStatus, string> = {
  installed: 'Installed — dashboard tiles are reading live rate-limit and context data',
  'installed-other': 'Another statusLine command is configured',
  'not-installed': 'Not installed — dashboard tiles fall back to estimates',
  unreadable: 'settings.json could not be read',
};

export function StatuslineCard() {
  const colors = useColors();
  const [state, setState] = useState<StatuslineState | null>(null);
  const [replacePickerOpen, setReplacePickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  async function refresh() {
    const s = await window.aetherElectron?.statusline.state();
    if (s) setState(s);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runInstall() {
    setBusy(true);
    setResultMsg(null);
    const result: ActionResult | undefined = await window.aetherElectron?.statusline.install();
    setBusy(false);
    setReplacePickerOpen(false);
    if (!result) return;
    setResultMsg(
      !result.ok
        ? result.error || 'Failed to install'
        : result.backupPath
          ? `Installed — settings.json backed up to ${result.backupPath}`
          : 'Installed'
    );
    await refresh();
  }

  async function runUninstall() {
    setBusy(true);
    setResultMsg(null);
    const result: ActionResult | undefined = await window.aetherElectron?.statusline.uninstall();
    setBusy(false);
    if (!result) return;
    setResultMsg(
      !result.ok
        ? result.error || 'Failed to uninstall'
        : result.backupPath
          ? `Uninstalled — settings.json backed up to ${result.backupPath}`
          : 'Uninstalled'
    );
    await refresh();
  }

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>STATUSLINE</div>

      {!state && <div style={hintStyle(colors)}>Checking…</div>}

      {state && (
        <>
          <div style={{ marginTop: 12 }}>
            <div style={labelStyle(colors)}>STATUS</div>
            <div style={valueStyle(colors, state.status)}>{STATUS_COPY[state.status]}</div>
            {state.status === 'installed-other' && state.existingCommand !== null && (
              <div style={commandBoxStyle(colors)}>{state.existingCommand}</div>
            )}
          </div>

          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            {state.status === 'not-installed' && (
              <Button onClick={runInstall} style={actionBtnStyle(colors)} disabled={busy}>
                Install
              </Button>
            )}

            {state.status === 'installed-other' && (
              <div style={{ position: 'relative' }}>
                <Button onClick={() => setReplacePickerOpen((v) => !v)} style={actionBtnStyle(colors)} disabled={busy}>
                  Replace
                </Button>
                {replacePickerOpen && (
                  <div style={confirmPanelStyle(colors)}>
                    <div style={confirmTextStyle(colors)}>
                      This overwrites the existing statusLine command shown above. A timestamped backup of settings.json
                      is written first.
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <Button onClick={runInstall} style={confirmYesStyle(colors)} disabled={busy}>
                        Confirm replace
                      </Button>
                      <Button onClick={() => setReplacePickerOpen(false)} style={confirmNoStyle(colors)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {state.status === 'installed' && (
              <Button onClick={runUninstall} style={dangerBtnStyle(colors)} disabled={busy}>
                Uninstall
              </Button>
            )}

            {state.status === 'unreadable' && (
              <div style={hintStyle(colors)}>
                Fix or remove the unparseable settings.json before Aether OS can manage the statusline.
              </div>
            )}
          </div>

          {resultMsg && <div style={statusLineStyle(colors)}>{resultMsg}</div>}
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
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function valueStyle(colors: ColorPalette, status: InstallStatus): CSSProperties {
  const color =
    status === 'installed'
      ? colors.success
      : status === 'installed-other'
        ? colors.warn
        : status === 'unreadable'
          ? colors.danger
          : colors.textBody;
  return { marginTop: 8, font: `600 13px/1.4 ${fonts.ui}`, color };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 6, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
function commandBoxStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 8,
    padding: '8px 10px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    font: `400 11px/1.4 ${fonts.mono}`,
    color: colors.textBody,
    wordBreak: 'break-all',
  };
}
function actionBtnStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelGradient,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.textPrimary,
  };
}
function dangerBtnStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 8,
    border: '1px solid rgba(255,107,122,.4)',
    background: colors.panelGradient,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.danger,
  };
}
function confirmPanelStyle(colors: ColorPalette): CSSProperties {
  return {
    position: 'absolute',
    top: '100%',
    left: 0,
    marginTop: 6,
    width: 320,
    zIndex: 70,
    padding: 12,
    borderRadius: 10,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    boxShadow: '0 20px 60px rgba(0,0,0,.6)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };
}
function confirmTextStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.4 ${fonts.ui}`, color: colors.textDim };
}
function confirmYesStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(255,107,122,.4)',
    background: colors.panelGradient,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.danger,
  };
}
function confirmNoStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelGradient,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
function statusLineStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `600 11px/1.3 ${fonts.ui}`, color: colors.accentCyanSoft };
}
