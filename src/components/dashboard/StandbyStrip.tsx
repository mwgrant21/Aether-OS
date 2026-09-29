import { Fragment, useId, type CSSProperties } from 'react';
import { fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { srOnlyStyle } from '../shared/srOnly';
import { computeDigestPresence, computeStripItems, type StripItemKey } from './readinessMath';

const TAB_BY_KEY: Record<Exclude<StripItemKey, 'alerts'>, string> = { agents: 'Agents', projects: 'Projects', memory: 'Memory' };

/**
 * One thin line for every digest with nothing to show, so an idle console
 * doesn't draw empty panels. Each count links to where that data will live.
 * Hidden once every digest has its own panel.
 */
export function StandbyStrip() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const headingId = useId();
  const items = computeStripItems(computeDigestPresence(state), state.memories.length);
  if (items.length === 0) return null;

  function go(key: StripItemKey) {
    if (key === 'alerts') {
      if (!state.notifOpen) dispatch({ type: 'TOGGLE_NOTIFS' });
      return;
    }
    dispatch({ type: 'SET_ACTIVE_TAB', tab: TAB_BY_KEY[key] });
  }

  return (
    <section aria-labelledby={headingId} style={stripStyle(colors)}>
      <h2 id={headingId} style={srOnlyStyle}>
        Standby
      </h2>
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && (
            <span aria-hidden="true" style={sepStyle(colors)}>
              ·
            </span>
          )}
          <Button onClick={() => go(it.key)} style={itemStyle}>
            <span style={labelStyle(colors)}>{it.label}</span> <span style={countStyle(colors)}>{it.count}</span>
            {it.unit !== null && (
              <>
                {' '}
                <span style={labelStyle(colors)}>{it.unit}</span>
              </>
            )}
          </Button>
        </Fragment>
      ))}
    </section>
  );
}

function stripStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: '10px 15px',
    borderRadius: radii.panel,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
  };
}
const itemStyle: CSSProperties = { cursor: 'pointer', padding: '4px 6px', borderRadius: radii.chip };
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textSecondary };
}
// Numbers Are Mono; counts use Soft Signal.
function countStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 12px/1 ${fonts.mono}`, color: colors.accentCyanSoft };
}
function sepStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1 ${fonts.mono}`, color: colors.textDim };
}
