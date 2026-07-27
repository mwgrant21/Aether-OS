import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';
import type { ProjectStub } from '../../state/types';
import { STATUS_COLOR, computeLiveProjectPct } from './projectsMath';

export function ProjectDetailCard({ project }: { project: ProjectStub | null }) {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();

  if (!project) {
    return (
      <div style={cardStyle(colors)}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO PROJECTS YET</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Add a project from the roster to see it here.
          </div>
        </div>
      </div>
    );
  }

  const pct = computeLiveProjectPct(project, state.used);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={swatchStyle(project.hue)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{project.name}</div>
        </div>
        <span style={statusBadgeStyle(STATUS_COLOR[project.status])}>{project.status}</span>
      </div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${pct}%`, background: project.hue, boxShadow: `0 0 10px ${project.hue}` }} />
      </div>
      <div style={{ marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: project.hue }}>{pct}% complete</span>
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={sectionLabelStyle(colors)}>CREW</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {project.crew.map((name) => (
            <Button
              key={name}
              onClick={() => {
                dispatch({ type: 'SELECT_AGENT', name });
                dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
              }}
              style={crewRowStyle(colors)}
            >
              {name}
            </Button>
          ))}
          {!project.crew.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no crew assigned</div>}
        </div>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    padding: 18,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
  };
}

const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};

function swatchStyle(hue: string): CSSProperties {
  return {
    width: 46,
    height: 46,
    flex: 'none',
    borderRadius: 10,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
  };
}

function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}

const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };

function sectionLabelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}

function crewRowStyle(colors: ColorPalette): CSSProperties {
  return {
    cursor: 'pointer',
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.accentCyanSoft,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid rgba(95,220,255,.2)',
    background: colors.panelInset,
    width: 'fit-content',
  };
}
