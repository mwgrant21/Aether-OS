import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { linePaths, niceDomain, pointX, pointY, seriesFrom } from './chartMath';
import { formatValue } from './formatValue';

const W = 640;
const H = 200;
const PAD_L = 72;
const PAD_B = 22;

export function LinePanel({ rows, x, y }: { rows: Record<string, unknown>[]; x: string; y: string[] }) {
  const colors = useColors();
  const { labels, series } = seriesFrom(rows, x, y);
  const { lo, hi } = niceDomain(series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const plotW = W - PAD_L;
  const plotH = H - PAD_B;
  const axisText = { fill: colors.textMuted, fontFamily: fonts.mono, fontSize: 10 };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${y.join(', ')} by ${x}`}>
      <line x1={PAD_L} y1={plotH} x2={W} y2={plotH} stroke={colors.chromeBorder} />
      {lo < 0 && <line x1={PAD_L} y1={pointY(0, plotH, lo, hi)} x2={W} y2={pointY(0, plotH, lo, hi)} stroke={colors.chromeBorder} strokeWidth={1} />}
      <text x={PAD_L - 6} y={10} textAnchor="end" {...axisText}>{formatValue(y[0], hi)}</text>
      <text x={PAD_L - 6} y={plotH} textAnchor="end" {...axisText}>{formatValue(y[0], lo)}</text>
      {labels.length > 0 && <text x={PAD_L} y={H - 6} {...axisText}>{labels[0]}</text>}
      {labels.length > 1 && <text x={W} y={H - 6} textAnchor="end" {...axisText}>{labels[labels.length - 1]}</text>}
      {series.map((s, i) => {
        const color = colors.agentHues[i % colors.agentHues.length];
        return (
          <g key={s.column} transform={`translate(${PAD_L},0)`}>
            {linePaths(s.values, plotW, plotH, lo, hi).map((d, j) => <path key={j} d={d} fill="none" stroke={color} strokeWidth={2} />)}
            {s.values.map((v, j) => v === null ? null : (
              <circle key={j} cx={pointX(j, s.values.length, plotW)} cy={pointY(v, plotH, lo, hi)} r={2.5} fill={color}>
                <title>{`${labels[j]}: ${formatValue(s.column, v)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
