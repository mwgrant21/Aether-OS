import { useCallback, useState, type CSSProperties } from 'react';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts } from '../styles/tokens';
import { ChatPane } from './ChatPane';
import { GuiNav } from './GuiNav';
import { useGuiProjects } from './useGuiProjects';

/** Electron's frameless drag region is a vendor CSS property not present in React's CSSProperties type. */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

const END_CHAT_PROMPT = 'End the current chat? Its Claude session will stop.';

export function GuiApp() {
  const colors = useColors();
  const projects = useGuiProjects();
  // The chat and the stub page are separate: a stub is an overlay on the chat, so the
  // ChatPane (and its session UI) stays mounted while a stub is shown.
  const [chatId, setChatId] = useState<string | null>(null);
  const [stub, setStub] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const openChat = useCallback(
    (id: string | null) => {
      if (id === chatId) {
        // Already the open chat: nothing to end; just leave any stub page.
        setStub(null);
        return;
      }
      if (live && !window.confirm(END_CHAT_PROMPT)) return;
      setLive(false);
      setStub(null);
      setChatId(id);
    },
    [chatId, live],
  );

  const unpin = useCallback(
    async (id: string) => {
      if (id === chatId && live && !window.confirm(END_CHAT_PROMPT)) return;
      const ok = await projects.unpin(id);
      if (ok && id === chatId) {
        setLive(false);
        setStub(null);
        setChatId(null);
      }
    },
    [chatId, live, projects],
  );

  const win = typeof window === 'undefined' ? undefined : window.aetherElectron?.window;
  const ctl: CSSProperties = { font: `600 14px/1 ${fonts.ui}`, color: colors.textSecondary, width: 40, height: 36 };
  const ctlHover: CSSProperties = { background: colors.panelInset, color: colors.textPrimary };
  const noDrag: AppRegionStyle = { display: 'flex', WebkitAppRegion: 'no-drag' };
  const strip: AppRegionStyle = {
    height: 36,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
    borderBottom: `1px solid ${colors.chromeBorder}`,
    background: colors.chromeBg,
    WebkitAppRegion: 'drag',
  };

  return (
    <div
      data-testid="gui-root"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: colors.bgBase, color: colors.textBody, font: `500 15px/1.4 ${fonts.ui}` }}
    >
      <div data-testid="gui-title-strip" style={strip}>
        <span style={{ font: `700 14px/1 ${fonts.ui}`, letterSpacing: 4, color: colors.textPrimary }}>AETHER</span>
        {win && (
          <div style={noDrag}>
            <Button onClick={() => win.minimize()} aria-label="Minimize" style={ctl} hoverStyle={ctlHover}>
              &#8211;
            </Button>
            <Button onClick={() => win.toggleMaximize()} aria-label="Maximize" style={ctl} hoverStyle={ctlHover}>
              &#9633;
            </Button>
            <Button onClick={() => win.close()} aria-label="Close" style={ctl} hoverStyle={{ ...ctlHover, color: colors.danger }}>
              &#10005;
            </Button>
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <GuiNav
          projects={projects}
          chatId={chatId}
          stub={stub}
          onNew={() => openChat(null)}
          onStub={setStub}
          onProject={openChat}
          onUnpin={(id) => void unpin(id)}
        />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: stub === null ? 'flex' : 'none', flexDirection: 'column' }}>
            <ChatPane key={chatId ?? 'new'} projectId={chatId} onLiveChange={setLive} />
          </div>
          {stub !== null && (
            <section aria-label={stub} style={{ padding: 32 }}>
              <h1 style={{ margin: 0, font: `700 22px/1.2 ${fonts.ui}`, color: colors.textPrimary }}>{stub}</h1>
              <p style={{ color: colors.textMuted }}>Not built yet - arrives in a later slice</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
