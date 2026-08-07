import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import type { CacheImpact } from '../../shared/ledgerMath';
import { usd, usdPrecise, tokens as fmtTokens } from './format';

/**
 * The counterfactual: what the cache reads would have cost at the full input
 * rate, minus what they did cost. The most actionable number in the view --
 * it is the one figure here that reflects a decision the operator can make.
 *
 * The saving is exact to the pricing table (it is derived from the same
 * per-event breakdown as the session card), so it carries no tilde. The
 * cache-read RATE it rests on is an approximation, and the footer says so.
 */
export function CacheImpactCard({ cache, hitRatio }: { cache: CacheImpact; hitRatio: number }) {
  const colors = useColors();

  return (
    <div style={cardStyle(colors)}>
      <div style={cardTitleStyle(colors)}>CACHE IMPACT</div>

      {cache.cacheReadTokens === 0 ? (
        <div style={emptyStyle(colors)}>No cache reads observed.</div>
      ) : (
        <>
          <div style={savedStyle(colors)}>{usd(cache.savedUsd)} saved</div>
          <div style={subStyle(colors)}>
            {fmtTokens(cache.cacheReadTokens)} cached tokens would have cost {usdPrecise(cache.wouldHaveCostUsd)} at
            the full input rate; they cost {usdPrecise(cache.actuallyCostUsd)}.
          </div>
        </>
      )}

      <div style={ratioRowStyle(colors)}>
        <span style={ratioLabelStyle(colors)}>Hit rate</span>
        <span style={ratioValueStyle(colors)}>{(hitRatio * 100).toFixed(1)}%</span>
      </div>
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
  marginBottom: 8,
});

const savedStyle = (c: ColorPalette): CSSProperties => ({
  font: `700 24px/1.2 ${fonts.mono}`,
  color: c.success,
});

const subStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.5 ${fonts.ui}`,
  color: c.textMuted,
  marginTop: 4,
});

const emptyStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 12px/1.5 ${fonts.ui}`,
  color: c.textDim,
});

const ratioRowStyle = (c: ColorPalette): CSSProperties => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginTop: 12,
  paddingTop: 10,
  borderTop: `1px solid ${c.chromeBorder}`,
});

const ratioLabelStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 10px/1 ${fonts.ui}`,
  letterSpacing: '.08em',
  color: c.textMuted,
});

const ratioValueStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 14px/1 ${fonts.mono}`,
  color: c.textBody,
});
