import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { planCostPerPoint, QUOTA_WINDOW_MS } from '../../shared/ledgerMath';

export function PlanPriceCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const price = state.cfg.planMonthlyUsd;

  function onChange(raw: string): void {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    // Empty, unparsable, or negative all clear to null -- but a deliberately
    // typed 0 is stored as 0, not coerced to null. Unset and zero are
    // different answers: null means "no price configured, show quota points
    // only"; 0 means "the operator says this plan costs nothing" and must
    // still render as $0.00. Collapsing the two would silently discard a
    // real (if unusual) entry the moment the operator typed it.
    const next = trimmed !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    dispatch({ type: 'UPDATE_CFG', patch: { planMonthlyUsd: next } });
  }

  const perPoint = price === null ? null : planCostPerPoint(price, QUOTA_WINDOW_MS.seven_day);

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>PLAN PRICE</div>

      <div style={rowStyle}>
        <label style={labelStyle(colors)} htmlFor="plan-monthly-usd">
          MONTHLY USD
        </label>
        <input
          id="plan-monthly-usd"
          aria-label="Monthly plan price in USD"
          type="number"
          min={0}
          step={1}
          value={price ?? ''}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle(colors)}
        />
      </div>

      <div style={rowStyle}>
        <div style={labelStyle(colors)}>PER QUOTA POINT (7D)</div>
        <div style={valueStyle(colors)}>{perPoint === null ? '—' : `$${perPoint.toFixed(2)}`}</div>
      </div>

      <p style={hintStyle(colors)}>
        {price === null
          ? 'Not set — the Ledger shows quota points only. Enter what this subscription costs per month and it will price work in the quota it actually consumes, instead of only in API rates this account never pays.'
          : 'A plan buys 100 rate-limit points per 7-day window, and a 28-day month holds four of them — so this price divides by 400. The Ledger amortizes each dispatch over that rate.'}
      </p>
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
const rowStyle: CSSProperties = {
  marginTop: 12,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, flexShrink: 0 };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary, textAlign: 'right' };
}
function inputStyle(colors: ColorPalette): CSSProperties {
  return {
    width: 110,
    padding: '4px 8px',
    borderRadius: 6,
    border: `1px solid ${colors.panelBorder}`,
    background: 'transparent',
    color: colors.textSecondary,
    font: `600 12px/1.2 ${fonts.mono}`,
    textAlign: 'right',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
