import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { planCostPerPoint, QUOTA_WINDOW_MS } from '../../shared/ledgerMath';
import { MIN_FIT_BUCKETS, type QuotaEfficiency } from '../../shared/quotaEfficiency';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { planUsd, points as fmtPoints, tokens as fmtTokens, QUOTA_BASIS_TOOLTIP } from './format';

/**
 * What the subscription actually paid for this window.
 *
 * The window-level figure deliberately does NOT go through the tokens-per-point
 * fit: the statusline reports the seven-day percentage directly, so points
 * consumed is a measurement, not an inference, and only the price is needed to
 * value it. The fit exists to ATTRIBUTE that consumption to individual
 * dispatches (DispatchCostTable), which is a strictly harder claim -- and this
 * card reports the fit's state so the operator can see how much weight the
 * per-dispatch column deserves.
 */
export function QuotaCostCard({
  quota,
  statusline,
  planMonthlyUsd,
}: {
  quota: QuotaEfficiency | null;
  statusline: StatuslineSnapshot | null;
  planMonthlyUsd: number | null;
}) {
  const colors = useColors();
  const sevenDay = statusline?.sevenDay ?? null;

  if (sevenDay === null) {
    return (
      <div style={cardStyle(colors)}>
        <div style={titleStyle(colors)} title={QUOTA_BASIS_TOOLTIP}>QUOTA COST · 7 DAY</div>
        <div style={emptyStyle(colors)}>
          No seven-day rate-limit data. Install the statusline hook from Settings — the percentage
          series this prices comes from it.
        </div>
      </div>
    );
  }

  const usedPoints = sevenDay.usedPercentage;
  // A $0 plan price still prices out to a real $0.00: planCostPerPoint(0, ...)
  // returns 0 (its own guard), never null, so a genuinely-entered $0 plan and
  // "no price configured" stay distinguishable -- perPoint is null ONLY when
  // planMonthlyUsd itself is null.
  const perPoint = planMonthlyUsd === null ? null : planCostPerPoint(planMonthlyUsd, QUOTA_WINDOW_MS.seven_day);

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)} title={QUOTA_BASIS_TOOLTIP}>QUOTA COST · 7 DAY</div>

      <div style={rowStyle}>
        <div style={labelStyle(colors)}>CONSUMED</div>
        <div style={valueStyle(colors)}>{fmtPoints(usedPoints)}</div>
      </div>

      {perPoint !== null && (
        <div style={rowStyle}>
          <div style={labelStyle(colors)}>PLAN VALUE</div>
          <div style={valueStyle(colors)}>{planUsd(usedPoints * perPoint)}</div>
        </div>
      )}

      <div style={rowStyle}>
        <div style={labelStyle(colors)}>TOKENS / POINT</div>
        <div style={valueStyle(colors)}>
          {quota?.tokensPerPoint != null
            ? fmtTokens(Math.round(quota.tokensPerPoint))
            : `fit forming — ${quota?.fittedBuckets ?? 0} of ${MIN_FIT_BUCKETS} hours`}
        </div>
      </div>

      <div style={rowStyle}>
        <div style={labelStyle(colors)}>OBSERVED HERE</div>
        <div style={valueStyle(colors)}>{fmtTokens(quota?.observedTokens ?? 0)}</div>
      </div>

      {quota != null && quota.externalUsageBuckets > 0 && (
        <p style={hintStyle(colors)}>
          External usage: {quota.externalUsageBuckets} hours where the account's quota moved but this
          machine logged no tokens — other machines or projects on the same account. Those hours are
          excluded from the tokens-per-point fit.
        </p>
      )}

      {planMonthlyUsd === null && (
        <p style={hintStyle(colors)}>
          Set a monthly plan price in Settings to see this window's consumption in dollars.
        </p>
      )}

      <p style={hintStyle(colors)}>
        This is what the subscription bought, not marginal spend — the plan costs the same whether
        this work ran or not. Tokens per point is fitted from observed percentage movement, so it is
        correlation, not a published rate.
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
  marginTop: 10,
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
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
