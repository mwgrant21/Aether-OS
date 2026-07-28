import { useEffect, useState, type CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { fmtElapsed } from '../../utils/format';
import type { ColorPalette } from '../../styles/tokens';
import type { FleetSessionRow } from '../../state/types';

export function FleetCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // state.fleet's row order isn't guaranteed by the reader's SQL (no ORDER BY),
  // so sort client-side without mutating the prop. Oldest/longest-running first.
  const sortedFleet = state.fleet?.slice().sort((a, b) => a.startedAtMs - b.startedAtMs) ?? null;

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>FLEET</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortedFleet === null && <div style={emptyStyle(colors)}>collector isn&apos;t running -- fleet data unavailable</div>}
        {sortedFleet !== null && sortedFleet.length === 0 && <div style={emptyStyle(colors)}>No other sessions detected</div>}
        {sortedFleet?.map((row) => (
          <FleetRow
            key={row.sessionId}
            row={row}
            now={now}
            colors={colors}
            expanded={row.sessionId === expandedSessionId}
            onToggle={() => setExpandedSessionId(expandedSessionId === row.sessionId ? null : row.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

function FleetRow({
  row,
  now,
  colors,
  expanded,
  onToggle,
}: {
  row: FleetSessionRow;
  now: number;
  colors: ColorPalette;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button onClick={onToggle} style={rowStyle(expanded)}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={nameStyle(colors)}>{row.projectName}</span>
          <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - row.startedAtMs)}</span>
        </div>
        <div style={descStyle(colors)}>
          <span>{row.name}</span> · <span style={statusChipStyle(colors, row.status)}>{row.status}</span>
        </div>
        {expanded && (
          <div style={detailStyle(colors)}>
            kind: {row.kind}
            {row.pid !== null && ` · pid: ${row.pid}`}
          </div>
        )}
      </div>
    </Button>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    width: 300,
    flex: 'none',
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
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function rowStyle(expanded: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: expanded ? 'rgba(23,184,216,.14)' : undefined,
    border: expanded ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function descStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.3 ${fonts.ui}`, color: colors.textDim, marginTop: 3 };
}
function detailStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 10px/1.4 ${fonts.mono}`, color: colors.textDim, marginTop: 5 };
}
function statusChipStyle(colors: ColorPalette, status: string): CSSProperties {
  return {
    font: `700 9px/1 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: status === 'busy' ? colors.success : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '1px 4px',
    borderRadius: 4,
  };
}
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.3 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
}
