import { useCallback, useEffect, useRef, useState } from 'react';
import { GUI_NO_OUTPUT_HINT_MS, type StartResult } from '../../electron/gui/guiTypes';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';
import { GuiComposer } from './GuiComposer';
import { GuiTerminal, type GuiTerminalHandle } from './GuiTerminal';
import { createReadyGate, type ReadyGate } from './readyGate';
import { createTrustWatcher, type TrustWatcher } from './trustPrompt';
import { useGuiProjects } from './useGuiProjects';

interface ChatPaneProps {
  projectId: string | null;
  onLiveChange: (live: boolean) => void;
}

const FAIL_TEXT: Record<string, string> = {
  'missing-dir': 'That folder no longer exists',
  unavailable: 'Folder storage is not available this run',
  'unknown-project': 'That project is no longer pinned',
  'spawn-failed': 'Claude could not be started',
  'bad-request': 'Claude could not be started',
};

const schedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function ChatPane({ projectId, onLiveChange }: ChatPaneProps) {
  const colors = useColors();
  const { projects } = useGuiProjects();
  const name = projectId === null ? 'New chat' : (projects.find((p) => p.id === projectId)?.name ?? 'Project');

  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [hint, setHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [trustShown, setTrustShown] = useState(false);

  const termRef = useRef<GuiTerminalHandle>(null);
  const gateRef = useRef<ReadyGate | null>(null);
  const watcherRef = useRef<TrustWatcher | null>(null);
  const mounted = useRef(false);
  const startSeq = useRef(0);
  const restartedOnReuse = useRef(false); // a reused start restarts the session at most once per mount
  const dropData = useRef(false); // true from a reused reply until the restart's own start reply: old-PTY output in flight must not reach the new gate
  const cancelHint = useRef<(() => void) | null>(null);
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;

  const setLiveBoth = useCallback((v: boolean) => {
    setLive(v);
    onLiveChangeRef.current(v);
  }, []);

  const clearHint = useCallback(() => {
    cancelHint.current?.();
    cancelHint.current = null;
  }, []);

  const begin = useCallback((replace = false) => {
    const gui = window.aetherElectron?.gui;
    const gate = gateRef.current;
    if (!gui || !gate) return;
    watcherRef.current?.reset();
    setTrustShown(false);
    const mySeq = ++startSeq.current;
    gate.reset();
    clearHint();
    setReady(false);
    setHint(false);
    setError(null);
    setStopped(false);
    cancelHint.current = schedule(() => setHint(true), GUI_NO_OUTPUT_HINT_MS);
    const { cols, rows } = termRef.current?.size() ?? { cols: 80, rows: 24 };
    const fail = (reason: string): void => {
      clearHint();
      setError(FAIL_TEXT[reason] ?? 'Claude could not be started');
      setStopped(true);
      setLiveBoth(false);
    };
    gui.start(replace ? { projectId, cols, rows, restart: true } : { projectId, cols, rows }).then(
      (r: StartResult) => {
        if (!mounted.current || mySeq !== startSeq.current) return;
        if (replace) dropData.current = false;
        if (!r.ok) return fail(r.reason);
        setLiveBoth(true);
        if (r.reused) {
          // The renderer has a fresh empty terminal, so a prompt the session is waiting on cannot be seen
          // and the composer must not enable. Replace the session once and let the normal ready gate run;
          // a second reused answer keeps the composer disabled (the no-output hint still shows).
          if (!restartedOnReuse.current) {
            restartedOnReuse.current = true;
            dropData.current = true;
            termRef.current?.reset();
            begin(true);
          }
        }
      },
      () => {
        if (mounted.current && mySeq === startSeq.current) {
          if (replace) dropData.current = false;
          fail('spawn-failed');
        }
      },
    );
  }, [projectId, clearHint, setLiveBoth]);

  useEffect(() => {
    mounted.current = true;
    const gate = createReadyGate({
      schedule,
      onReady: () => setReady(true),
    });
    gateRef.current = gate;
    watcherRef.current = createTrustWatcher({
      schedule,
      readScreen: () => termRef.current?.screenText() ?? '',
      onChange: setTrustShown,
    });
    // Deferred so StrictMode's discarded first run never reaches gui.start (a second start would be
    // answered reused:true and force the composer ready); the child has subscribed onData by then.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) begin();
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearHint();
      gate.dispose();
      gateRef.current = null;
      watcherRef.current?.dispose();
      watcherRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ChatPane is keyed by projectId: one start per mount
  }, []);

  const onChunk = useCallback(() => {
    clearHint();
    setHint(false);
    gateRef.current?.feed();
    watcherRef.current?.feed();
  }, [clearHint]);

  const acceptData = useCallback(() => !dropData.current, []);

  const onExit = useCallback(() => {
    startSeq.current += 1;
    dropData.current = false;
    clearHint();
    gateRef.current?.reset(); // clears pending quiet/ceiling timers
    watcherRef.current?.reset();
    setTrustShown(false);
    setReady(false);
    setHint(false);
    setStopped(true);
    setLiveBoth(false);
  }, [clearHint, setLiveBoth]);

  const restart = (): void => {
    termRef.current?.reset();
    begin();
  };

  const onSubmit = async (text: string): Promise<boolean> => {
    try {
      return (await window.aetherElectron?.gui?.submit(text)) === true;
    } catch {
      return false;
    }
  };

  const enabled = live && ready && !trustShown;
  const placeholder = stopped
    ? 'Claude is not running'
    : trustShown
      ? 'Waiting for your answer in the pane'
      : !enabled
        ? 'Starting Claude...'
        : 'Message Claude';
  const hintText = hint && !ready && !error ? 'No output from Claude yet. Type in the pane.' : null;
  const message = error ?? (trustShown ? "Answer Claude's trust prompt in the pane first" : hintText);

  return (
    <div data-testid="chat-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 24px', color: colors.textPrimary, font: `600 16px/1.3 ${fonts.ui}` }}>{name}</div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <GuiTerminal ref={termRef} onChunk={onChunk} onExit={onExit} acceptData={acceptData} />
      </div>
      {(message || stopped) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 24px', color: colors.textMuted, font: `500 13px/1.4 ${fonts.ui}` }}>
          {message && <span role="status">{message}</span>}
          {stopped ? (
            <Button
              onClick={restart}
              style={{ padding: '4px 12px', borderRadius: radii.chip, font: `600 13px/1.2 ${fonts.ui}`, color: colors.textPrimary, border: `1px solid ${colors.chromeBorder}`, background: 'transparent' }}
            >
              Restart
            </Button>
          ) : null}
        </div>
      )}
      <GuiComposer disabled={!enabled} placeholder={placeholder} onSubmit={onSubmit} />
    </div>
  );
}
