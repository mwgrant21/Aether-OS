import { useEffect } from 'react';
import type { CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { RecapPayload } from '../../state/types';
import type { ColorPalette } from '../../styles/tokens';

const AUTO_DISMISS_MS = 10000;

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function RecapBanner({ recap, onDismiss }: { recap: RecapPayload | null; onDismiss: () => void }) {
  const colors = useColors();

  useEffect(() => {
    if (!recap) return;
    const id = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [recap, onDismiss]);

  if (!recap) return null;

  const dispatchCount = recap.entries.filter((e) => e.kind === 'dispatchCompleted').length;
  const anomalyDetectedCount = recap.entries.filter((e) => e.kind === 'anomalyDetected').length;
  const anomalyClearedCount = recap.entries.filter((e) => e.kind === 'anomalyCleared').length;

  const parts: string[] = [];
  if (dispatchCount > 0) parts.push(`${dispatchCount} ${plural(dispatchCount, 'dispatch', 'dispatches')} completed`);
  if (anomalyDetectedCount > 0) parts.push(`${anomalyDetectedCount} ${plural(anomalyDetectedCount, 'anomaly', 'anomalies')} detected`);
  if (anomalyClearedCount > 0) parts.push(`${anomalyClearedCount} ${plural(anomalyClearedCount, 'anomaly', 'anomalies')} cleared`);
  parts.push(`${recap.tokensBurned.toLocaleString()} tokens burned`);

  return (
    <div style={bannerStyle(colors)}>
      <span style={{ font: `400 12px/1.4 ${fonts.ui}`, color: colors.textBody }}>
        Since you last looked: {parts.join(', ')}.
      </span>
      <Button onClick={onDismiss} title="dismiss recap" style={dismissStyle(colors)}>
        Dismiss
      </Button>
    </div>
  );
}

function bannerStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '8px 14px',
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 6,
  };
}

function dismissStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1 ${fonts.ui}`, color: colors.textMuted, padding: '2px 6px' };
}
