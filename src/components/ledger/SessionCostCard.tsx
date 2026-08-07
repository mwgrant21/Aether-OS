import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import type { ExactCost } from '../../shared/ledgerMath';
import type { PricingTier } from '../../shared/modelPricing';
import { usd, usdPrecise } from './format';

/**
 * The only exact figure in this view.
 *
 * No tilde anywhere in here, deliberately: this total is exact to the pricing
 * table, and marking it as approximate would be as misleading as leaving the
 * tilde off an estimate. The breakdown sums to the total by construction --
 * costForEvent is defined as the sum of costBreakdownForEvent -- so the parts
 * shown here provably add up to the number above them.
 */
export function SessionCostCard({ session, tiers }: { session: ExactCost; tiers: PricingTier[] }) {
  const colors = useColors();
  const { input, output, cacheCreation, cacheRead } = session.breakdown;

  return (
    <div style={cardStyle(colors)}>
      <div style={cardTitleStyle(colors)}>OBSERVED SESSION COST</div>
      <div style={totalStyle(colors)}>{usd(session.usd)}</div>
      <div style={tierLineStyle(colors)}>
        {tiers.length === 0 ? 'no priced activity observed' : `tier${tiers.length > 1 ? 's' : ''}: ${tiers.join(', ')}`}
      </div>

      <div style={breakdownStyle}>
        <Part label="Input" value={input} colors={colors} />
        <Part label="Output" value={output} colors={colors} />
        <Part label="Cache write" value={cacheCreation} colors={colors} />
        <Part label="Cache read" value={cacheRead} colors={colors} />
      </div>
    </div>
  );
}

function Part({ label, value, colors }: { label: string; value: number; colors: ColorPalette }) {
  return (
    <div style={partStyle}>
      <div style={partLabelStyle(colors)}>{label}</div>
      <div style={partValueStyle(colors)}>{usdPrecise(value)}</div>
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

const totalStyle = (c: ColorPalette): CSSProperties => ({
  font: `700 32px/1.1 ${fonts.mono}`,
  color: c.accentCyan,
});

const tierLineStyle = (c: ColorPalette): CSSProperties => ({
  font: `400 11px/1.4 ${fonts.ui}`,
  color: c.textMuted,
  marginTop: 2,
});

const breakdownStyle: CSSProperties = {
  display: 'flex',
  gap: 20,
  flexWrap: 'wrap',
  marginTop: 14,
};

const partStyle: CSSProperties = { minWidth: 88 };

const partLabelStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 10px/1.4 ${fonts.ui}`,
  letterSpacing: '.08em',
  color: c.textMuted,
});

const partValueStyle = (c: ColorPalette): CSSProperties => ({
  font: `500 14px/1.3 ${fonts.mono}`,
  color: c.textBody,
});
