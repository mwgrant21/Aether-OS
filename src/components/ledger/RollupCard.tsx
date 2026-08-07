import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import type { RollupBuckets } from '../../shared/ledgerMath';
import { usdPrecise } from './format';

/**
 * Today / week / month.
 *
 * The single most important rendering rule in this view lives here: a `null`
 * bucket renders as an explicit no-data gap and NEVER as $0.00. Zero and
 * unknown are different answers, and confusing them in a cost view is how an
 * operator concludes a quiet day when the collector was simply not running.
 */
export function RollupCard({ rollups }: { rollups: RollupBuckets }) {
  const colors = useColors();
  return (
    <div style={cardStyle(colors)}>
      <div style={cardTitleStyle(colors)}>ROLLUP</div>
      <div style={rowsStyle}>
        <Bucket label="Today" value={rollups.today} colors={colors} />
        <Bucket label="Last 7 days" value={rollups.week} colors={colors} />
        <Bucket label="This month" value={rollups.month} colors={colors} />
      </div>
      <div style={noteStyle(colors)}>
        Week is a rolling 7 days; month is the calendar month, in this machine's time zone.
      </div>
    </div>
  );
}

function Bucket({ label, value, colors }: { label: string; value: number | null; colors: ColorPalette }) {
  return (
    <div style={bucketStyle}>
      <div style={bucketLabelStyle(colors)}>{label}</div>
      {value === null ? (
        <div style={noDataStyle(colors)} title="No priced activity was observed for this period. This is not the same as spending nothing.">
          no data — collector not running
        </div>
      ) : (
        <div style={bucketValueStyle(colors)}>{usdPrecise(value)}</div>
      )}
    </div>
  );
}

const cardStyle = (c: ColorPalette): CSSProperties => ({
  background: c.panelGradient,
  border: `1px solid ${c.panelBorder}`,
  borderRadius: 8,
  padding: '14px 16px',
});

const cardTitleStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: '.14em',
  color: c.textSecondary,
  marginBottom: 12,
});

const rowsStyle: CSSProperties = { display: 'flex', gap: 24, flexWrap: 'wrap' };

const bucketStyle: CSSProperties = { minWidth: 130 };

const bucketLabelStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 11px/1.4 ${fonts.ui}`,
  color: c.textMuted,
  marginBottom: 4,
});

const bucketValueStyle = (c: ColorPalette): CSSProperties => ({
  font: `600 20px/1.2 ${fonts.mono}`,
  color: c.textPrimary,
});

const noDataStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.3 ${fonts.ui}`,
  color: c.textDim,
  fontStyle: 'italic',
  maxWidth: 130,
});

const noteStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 10px/1.4 ${fonts.ui}`,
  color: c.textDim,
  marginTop: 12,
});
