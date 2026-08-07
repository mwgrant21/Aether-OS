import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import {
  PRICING_VERIFIED_AT,
  PRICING_PER_MILLION_TOKENS,
  CACHE_READ_DISCOUNT,
  CACHE_WRITE_MULTIPLIER,
} from '../../shared/modelPricing';

/**
 * Small, dim, always present.
 *
 * This is what stops the pricing table from silently ageing into wrong. Rates
 * change; without a visible verification date the next reader has no way to
 * know whether the dollar figures above are current or two years stale. It
 * renders the actual constants in force rather than a prose restatement of
 * them, so it cannot drift away from the arithmetic it describes.
 */
export function PricingBasisFooter() {
  const colors = useColors();
  const tiers = Object.entries(PRICING_PER_MILLION_TOKENS);

  return (
    <div style={footerStyle(colors)}>
      <span>
        Pricing verified <strong style={strongStyle(colors)}>{PRICING_VERIFIED_AT}</strong> ·{' '}
      </span>
      <span>
        {tiers.map(([tier, rates], i) => (
          <span key={tier}>
            {i > 0 ? ' · ' : ''}
            {tier} ${rates.input}/${rates.output} per Mtok
          </span>
        ))}
      </span>
      <span>
        {' '}
        · cache read {CACHE_READ_DISCOUNT * 100}% of input, cache write {CACHE_WRITE_MULTIPLIER}× input
      </span>
    </div>
  );
}

const footerStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 10px/1.6 ${fonts.ui}`,
  color: c.textDim,
  borderTop: `1px solid ${c.chromeBorder}`,
  paddingTop: 10,
  marginTop: 4,
});

const strongStyle = (c: ColorPalette): CSSProperties => ({
  color: c.textMuted,
  fontWeight: 600,
});
