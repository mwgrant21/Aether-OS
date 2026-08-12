import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { formatFileSize } from '../files/attachmentsMath';
import type { RetentionStatus } from '../../../electron/retentionStore';

export function RetentionCard() {
  const colors = useColors();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function refresh() {
    const retention = window.aetherElectron?.retention;
    if (!retention) return;
    const s = await retention.status();
    setStatus(s);
  }

  useEffect(() => {
    refresh();
  }, []);

  const totalRows = status
    ? Object.values(status.rowCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  async function runPurge() {
    const retention = window.aetherElectron?.retention;
    if (!retention) return;
    setBusy(true);
    setErrorMsg(null);
    const result = await retention.purge();
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setErrorMsg(result.error || 'Purge failed');
      return;
    }
    await refresh();
  }

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>RETENTION &amp; PURGE</div>

      {!status && <div style={hintStyle(colors)}>Checking…</div>}

      {status && !status.exists && <div style={hintStyle(colors)}>No collector data yet.</div>}

      {status && status.exists && (
        <>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>STORE SIZE</div>
            <div style={valueStyle(colors)}>{formatFileSize(status.fileSizeBytes)}</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>ROWS RETAINED</div>
            <div style={valueStyle(colors)}>{totalRows}</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>OLDEST RETAINED</div>
            <div style={valueStyle(colors)}>
              {status.oldestRetainedAtMs === null ? '—' : new Date(status.oldestRetainedAtMs).toLocaleString()}
            </div>
          </div>

          <Button
            onClick={() => setConfirming(true)}
            disabled={busy}
            style={{ ...toggleStyle(colors, false), marginTop: 12 }}
          >
            PURGE ALL COLLECTED DATA
          </Button>

          {confirming && (
            <div style={confirmWrapStyle(colors)}>
              <p style={disclosureStyle(colors)}>
                Permanently deletes everything the collector has observed on this machine — every
                event, dispatch, tool call, anomaly, and rollup — including the daily rollups that
                normally survive automatic 30-day retention. This cannot be undone. Memory decisions
                (`memory.db`) are a separate store and are not affected.
              </p>
              <p style={disclosureStyle(colors)}>
                Deleting {formatFileSize(status.fileSizeBytes)} across {totalRows} rows, oldest from{' '}
                {status.oldestRetainedAtMs === null ? 'n/a' : new Date(status.oldestRetainedAtMs).toLocaleDateString()}.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button onClick={runPurge} disabled={busy} style={toggleStyle(colors, true)}>
                  {busy ? 'PURGING…' : 'I UNDERSTAND, PURGE'}
                </Button>
                <Button onClick={() => setConfirming(false)} disabled={busy} style={toggleStyle(colors, false)}>
                  CANCEL
                </Button>
              </div>
            </div>
          )}

          {errorMsg && <p style={{ ...hintStyle(colors), color: colors.textSecondary }}>{errorMsg}</p>}
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
