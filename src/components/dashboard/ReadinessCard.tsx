import { useId, type CSSProperties } from 'react';
import { dotGlow, fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { isSessionLive } from './dashboardMath';
import { computeReadiness, hasDesktopApp } from './readinessMath';
import { OpenTerminalButton } from './OpenTerminalButton';

/**
 * READINESS: what the console needs before it can show live work, as four
 * plain sentences. Met is Nominal Green; unmet is a hollow muted ring -- never
 * amber, because none of these asks the operator for anything. A dot glows
 * only while the session is live (Glow Is State): a met Terminal row at
 * STANDBY is a flat green dot. No live-region announcements here: the Footer
 * is the one status announcement.
 */
export function ReadinessCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const headingId = useId();
  const now = Date.now();
  const live = isSessionLive(state, now);
  const rows = computeReadiness(state, hasDesktopApp(), now);
  return (
    <section aria-labelledby={headingId} style={cardStyle(colors)}>
      <h2 id={headingId} style={{ ...titleStyle(colors), margin: 0 }}>
        READINESS
      </h2>
      <ul style={listStyle}>
        {rows.map((r) => (
          <li key={r.key} data-testid={`readiness-${r.key}`} style={rowStyle(colors)}>
            <span aria-hidden="true" data-testid={`readiness-dot-${r.key}`} style={dotStyle(colors, r.met, r.glows && live)} />
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <OpenTerminalButton live={live} />
    </section>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    padding: 15,
    borderRadius: radii.panel,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
const listStyle: CSSProperties = { listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 9 };
function rowStyle(colors: ColorPalette): CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 10, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textBody };
}
function dotStyle(colors: ColorPalette, met: boolean, glowing: boolean): CSSProperties {
  return {
    flex: 'none',
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: met ? colors.success : 'transparent',
    border: `1px solid ${met ? colors.success : colors.textMuted}`,
    boxShadow: met && glowing ? dotGlow(colors.success) : undefined,
  };
}
