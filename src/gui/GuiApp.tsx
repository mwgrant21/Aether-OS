import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { GUI_DEFAULT_PERMISSION_MODE, GUI_NEW_KEY, type GuiPermissionMode } from '../../electron/gui/guiTypes';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts } from '../styles/tokens';
import { GUI_BG_MARKER_RELIABLE } from './busyGate';
import { ChatPane, type ChatPaneStatus } from './ChatPane';
import { GuiNav, type NavStatus } from './GuiNav';
import { useGuiProjects } from './useGuiProjects';

/** Electron's frameless drag region is a vendor CSS property not present in React's CSSProperties type. */
type AppRegionStyle = CSSProperties & { WebkitAppRegion?: 'drag' | 'no-drag' };

const UNPIN_BUSY_PROMPT = 'This chat is working. Remove it anyway? Its Claude will stop.';

export function GuiApp() {
  const colors = useColors();
  const projects = useGuiProjects();
  // Every chat that has a mounted pane. Hidden panes keep running: a busy chat is never stopped by a plain switch.
  // The stub page is an overlay on the chats, so the panes (and their sessions) stay mounted while one is shown.
  const [panes, setPanes] = useState<string[]>([GUI_NEW_KEY]);
  const [chatKey, setChatKey] = useState<string>(GUI_NEW_KEY);
  const [stub, setStub] = useState<string | null>(null);
  const [navStatus, setNavStatus] = useState<Record<string, NavStatus | undefined>>({}); // dot per chat
  const [modes, setModes] = useState<Record<string, GuiPermissionMode>>({}); // per chat; survives an idle-stop and return
  // Decisions read refs, not state: they must see the state at the instant of the click.
  const panesRef = useRef(panes);
  const chatKeyRef = useRef(chatKey);
  const statusRef = useRef<Record<string, ChatPaneStatus>>({});
  const resumable = useRef<Record<string, boolean>>({}); // a pinned chat stopped idle that holds a conversation to resume
  const resumeFor = useRef<Record<string, boolean>>({ [GUI_NEW_KEY]: true }); // the resume flag each pane was mounted with

  const commit = (nextPanes: string[], nextKey: string): void => {
    panesRef.current = nextPanes;
    chatKeyRef.current = nextKey;
    setPanes(nextPanes);
    setChatKey(nextKey);
  };

  const setDot = (key: string, st: NavStatus | undefined): void => setNavStatus((prev) => (prev[key] === st ? prev : { ...prev, [key]: st }));

  /** Stops the chat's Claude and drops its pane, remembering whether it holds a conversation to resume. */
  const endChat = (key: string, panesNow: string[]): string[] => {
    window.aetherElectron?.gui?.stop(key);
    resumable.current[key] = statusRef.current[key]?.hasSent === true;
    delete statusRef.current[key];
    setDot(key, undefined);
    return panesNow.filter((k) => k !== key);
  };

  /** Shows the chat's pane, mounting it first when it has none. New always resumes; a pinned chat only when it was stopped holding a conversation. */
  const activate = (key: string, panesNow: string[]): void => {
    let next = panesNow;
    if (!next.includes(key)) {
      resumeFor.current[key] = key === GUI_NEW_KEY ? true : resumable.current[key] === true;
      delete resumable.current[key]; // consumed: the new pane's own hasSent decides the next return
      next = [...next, key];
    }
    commit(next, key);
    setNavStatus((prev) => (prev[key] === 'ready' ? { ...prev, [key]: undefined } : prev)); // opening a chat clears its "reply ready" mark
  };

  const openChat = useCallback((id: string | null) => {
    const target = id ?? GUI_NEW_KEY;
    setStub(null);
    const prev = chatKeyRef.current;
    if (target === prev) return; // already the open chat: just leave any stub page
    let next = panesRef.current;
    if (next.includes(prev)) {
      const st = statusRef.current[prev];
      const idle = (st?.state ?? 'idle') === 'idle';
      const autoStop = (st?.trusted ?? true) && GUI_BG_MARKER_RELIABLE;
      // Busy (working or waiting, including a background task) is never stopped. An idle chat is stopped, unless
      // auto-stop is off and it holds a conversation: then it keeps running until the user stops it.
      if (idle && (autoStop || st?.hasSent !== true)) next = endChat(prev, next);
    }
    activate(target, next);
  }, []);

  /** A chat's pane reported. A background chat that settled (idle, quiet, idle again) while auto-stop is on stops itself. */
  const onPaneStatus = (key: string, st: ChatPaneStatus): void => {
    statusRef.current[key] = st;
    const background = key !== chatKeyRef.current;
    const autoStop = st.trusted && GUI_BG_MARKER_RELIABLE;
    if (background && st.settled && st.state === 'idle' && autoStop && panesRef.current.includes(key)) {
      commit(endChat(key, panesRef.current), chatKeyRef.current);
      if (st.hasSent) setDot(key, 'ready');
      return;
    }
    if (st.state === 'working' || st.state === 'waiting') setDot(key, st.state);
    else setNavStatus((prev) => (prev[key] === 'ready' || prev[key] === undefined ? prev : { ...prev, [key]: undefined }));
  };

  /** Stop chat (auto-stop off): ends the chat; when it was the open one the New chat is shown. */
  const stopChat = (key: string): void => {
    const next = endChat(key, panesRef.current);
    if (chatKeyRef.current === key) activate(GUI_NEW_KEY, next);
    else commit(next, chatKeyRef.current);
  };

  const unpin = useCallback(
    async (id: string) => {
      const busy = panesRef.current.includes(id) && (statusRef.current[id]?.state ?? 'idle') !== 'idle';
      if (busy && !window.confirm(UNPIN_BUSY_PROMPT)) return;
      const ok = await projects.unpin(id);
      if (!ok) return;
      let next = panesRef.current;
      if (next.includes(id)) next = endChat(id, next);
      delete resumable.current[id];
      delete resumeFor.current[id];
      if (chatKeyRef.current === id) {
        setStub(null);
        activate(GUI_NEW_KEY, next);
      } else {
        commit(next, chatKeyRef.current);
      }
    },
    [projects],
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
          chatId={chatKey === GUI_NEW_KEY ? null : chatKey}
          stub={stub}
          onNew={() => openChat(null)}
          onStub={setStub}
          onProject={openChat}
          onUnpin={(id) => void unpin(id)}
          status={navStatus}
        />
        <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, display: stub === null ? 'flex' : 'none', flexDirection: 'column' }}>
            {panes.map((k) => (
              <ChatPane
                key={k}
                projectId={k === GUI_NEW_KEY ? null : k}
                active={k === chatKey}
                resume={resumeFor.current[k]}
                mode={modes[k] ?? GUI_DEFAULT_PERMISSION_MODE}
                onModeChange={(m) => setModes((prev) => ({ ...prev, [k]: m }))}
                onStatus={(st) => onPaneStatus(k, st)}
                onStopChat={() => stopChat(k)}
              />
            ))}
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
