import { Fragment, useId, type CSSProperties } from 'react';
import { dotGlow, fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { isSessionLive } from './dashboardMath';
import { computeReadiness, hasDesktopApp, splitHintCommands } from './readinessMath';
import { OpenTerminalButton } from './OpenTerminalButton';

/**
 * READINESS: what the console needs before it can show live work. Each met
 * row says when it was last true; each unmet row adds one hint line saying
 * how to fix it. Met is Nominal Green; unmet is a hollow muted ring -- never
 * amber, because none of these asks the operator for anything. A dot glows
 * only while the session is live (Glow Is State). No live-region
 * announcements here: the Footer is the one status announcement.
 *
 * The card fills the right column beside the reactor (flex: 1) only when no
 * digest panel is present -- with one up, an equal share just moves dead
 * space into READINESS and steals it from the digest. The rows keep their
 * rhythm at the top; the stretch goes between the last row and OPEN
 * TERMINAL, which is pinned to the card's bottom edge.
 */
export function ReadinessCard({ fill = true }: { fill?: boolean } = {}) {
  const colors = useColors();
  const { state } = useAetherStore();
  const headingId = useId();
  const now = Date.now();
  const live = isSessionLive(state, now);
  const rows = computeReadiness(state, hasDesktopApp(), now);
  return (
    <section aria-labelledby={headingId} style={cardStyle(colors, fill)}>
      <h2 id={headingId} style={{ ...titleStyle(colors), margin: 0 }}>
        READINESS
      </h2>
      <ul style={listStyle}>
        {rows.map((r) => (
          <li key={r.key} data-testid={`readiness-${r.key}`} style={rowStyle(colors)}>
            <span aria-hidden="true" data-testid={`readiness-dot-${r.key}`} style={dotStyle(colors, r.met, r.glows && live)} />
            <span data-testid={`readiness-text-${r.key}`} style={sentenceStyle}>
              {r.text}
            </span>
            {r.hint !== null && (
              <span data-testid={`readiness-hint-${r.key}`} style={hintStyle(colors)}>
                {splitHintCommands(r.hint).map((part, i) =>
                  part.command ? (
                    <code key={i} style={commandStyle}>
                      {part.text}
                    </code>
                  ) : (
                    <Fragment key={i}>{part.text}</Fragment>
                  ),
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div data-testid="readiness-action" style={actionWrapStyle}>
        <OpenTerminalButton live={live} />
      </div>
    </section>
  );
}

function cardStyle(colors: ColorPalette, fill: boolean): CSSProperties {
  return {
    flex: fill ? 1 : 'none',
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
// Two columns: the 8px dot, then the sentence with its hint beneath it, so a
// wrapped or hinted line stays indented clear of the dot.
function rowStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: '8px 1fr',
    columnGap: 10,
    rowGap: 2,
    alignItems: 'center',
    font: `400 12px/1.5 ${fonts.ui}`,
    color: colors.textBody,
  };
}
const sentenceStyle: CSSProperties = { gridColumn: 2, gridRow: 1 };
function hintStyle(colors: ColorPalette): CSSProperties {
  // Longhands, not the `font` shorthand, so the 11px floor is checkable.
  return { gridColumn: 2, gridRow: 2, fontFamily: fonts.ui, fontWeight: 400, fontSize: 11, lineHeight: 1.5, color: colors.textMuted };
}
const commandStyle: CSSProperties = { fontFamily: fonts.mono, fontSize: 11 };
const actionWrapStyle: CSSProperties = { marginTop: 'auto' };
function dotStyle(colors: ColorPalette, met: boolean, glowing: boolean): CSSProperties {
  return {
    gridColumn: 1,
    gridRow: 1,
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: met ? colors.success : 'transparent',
    border: `1px solid ${met ? colors.success : colors.textMuted}`,
    boxShadow: met && glowing ? dotGlow(colors.success) : undefined,
  };
}
