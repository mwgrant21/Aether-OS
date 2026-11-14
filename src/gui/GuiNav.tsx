import type { CSSProperties } from 'react';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';
import { GUI_NEW_KEY } from '../../electron/gui/guiTypes';
import type { GuiProjectsApi } from './useGuiProjects';

const STUBS_ABOVE = ['Search'] as const;
const STUBS_BELOW = ['Artifacts', 'Scheduled', 'Design', 'Customize'] as const;

export type NavStatus = 'working' | 'waiting' | 'ready';

interface GuiNavProps {
  projects: GuiProjectsApi;
  /** Null = the "New" chat. */
  chatId: string | null;
  /** Name of the stub page being shown, or null while the chat is shown. */
  stub: string | null;
  onNew: () => void;
  onStub: (name: string) => void;
  onProject: (id: string) => void;
  onUnpin: (id: string) => void;
  /** Per chat key (project id or GUI_NEW_KEY): a dot after the name. */
  status?: Record<string, NavStatus | undefined>;
}

export function GuiNav({ projects, chatId, stub, onNew, onStub, onProject, onUnpin, status = {} }: GuiNavProps) {
  const colors = useColors();
  const dot = (key: string) => {
    const st = status[key];
    if (!st) return null;
    const label = st === 'working' ? 'working' : st === 'waiting' ? 'needs you' : 'reply ready';
    const color = st === 'waiting' ? colors.warn : colors.accentCyan;
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          flex: 'none',
          margin: '0 4px 0 8px',
          boxSizing: 'border-box',
          borderRadius: '50%',
          verticalAlign: 'middle',
          background: st === 'ready' ? 'transparent' : color,
          border: st === 'ready' ? `2px solid ${color}` : 'none',
        }}
      />
    );
  };
  const item = (active: boolean): CSSProperties => ({
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 12px',
    borderRadius: radii.chip,
    font: `600 15px/1.2 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: active ? colors.textPrimary : colors.textSecondary,
    background: active ? colors.accentCyanSoft : 'transparent',
    border: `1px solid ${active ? colors.activeBorder : 'transparent'}`,
    textAlign: 'left',
  });
  const hover: CSSProperties = { background: colors.panelInset };
  const newActive = stub === null && chatId === null;
  const stubButton = (n: string) => (
    <Button key={n} onClick={() => onStub(n)} style={item(stub === n)} hoverStyle={hover} aria-current={stub === n ? 'page' : undefined}>
      {n}
    </Button>
  );

  return (
    <nav
      aria-label="Aether Chat navigation"
      style={{
        width: 260,
        flex: 'none',
        boxSizing: 'border-box',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        overflowY: 'auto',
        borderRight: `1px solid ${colors.chromeBorder}`,
        background: colors.chromeBg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Button onClick={onNew} style={{ ...item(newActive), flex: 1, minWidth: 0 }} hoverStyle={hover} aria-current={newActive ? 'page' : undefined}>
          New
        </Button>
        {dot(GUI_NEW_KEY)}
      </div>
      {STUBS_ABOVE.map(stubButton)}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          margin: '14px 4px 4px',
          font: `700 12px/1 ${fonts.ui}`,
          letterSpacing: 2,
          color: colors.textMuted,
          textTransform: 'uppercase',
        }}
      >
        <span>Projects</span>
        {projects.available && (
          <Button
            onClick={() => void projects.pin()}
            style={{ font: `600 13px/1 ${fonts.ui}`, color: colors.accentCyan, padding: '4px 6px' }}
            hoverStyle={{ color: colors.textPrimary }}
          >
            Pin folder
          </Button>
        )}
      </div>
      {!projects.available && (
        <div style={{ padding: '4px 12px', font: `500 13px/1.3 ${fonts.ui}`, color: colors.textMuted }}>Requires the Electron app</div>
      )}
      {projects.error && (
        <div role="alert" style={{ padding: '4px 12px', font: `500 13px/1.3 ${fonts.ui}`, color: colors.dangerSoft }}>
          {projects.error}
        </div>
      )}
      {projects.projects.map((p) => {
        const active = stub === null && chatId === p.id;
        return (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button
              onClick={() => onProject(p.id)}
              style={{ ...item(active), flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              hoverStyle={hover}
              aria-current={active ? 'page' : undefined}
              title={p.name}
            >
              {p.name}
            </Button>
            {dot(p.id)}
            <Button
              onClick={() => onUnpin(p.id)}
              aria-label={`Remove ${p.name}`}
              title="Remove from pinned folders"
              style={{ flex: 'none', padding: '6px 8px', font: `600 14px/1 ${fonts.ui}`, color: colors.textMuted }}
              hoverStyle={{ color: colors.danger }}
            >
              x
            </Button>
          </div>
        );
      })}

      <div style={{ height: 14 }} />
      {STUBS_BELOW.map(stubButton)}
    </nav>
  );
}
