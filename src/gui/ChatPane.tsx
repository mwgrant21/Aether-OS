import { useCallback, useEffect, useRef, useState } from 'react';
import { GUI_DEFAULT_PERMISSION_MODE, GUI_NO_OUTPUT_HINT_MS, type GuiPermissionMode, type StartResult } from '../../electron/gui/guiTypes';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';
import { createBusyGate, type BusyGate, type BusyState } from './busyGate';
import { ConfirmPopup } from './ConfirmPopup';
import { GuiComposer } from './GuiComposer';
import { GuiTerminal, type GuiTerminalHandle } from './GuiTerminal';
import { MODE_LABELS, ModePicker } from './ModePicker';
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

interface BeginOptions {
  replace?: boolean;
  resume?: boolean;
  mode?: GuiPermissionMode;
}

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
  const [mode, setMode] = useState<GuiPermissionMode>(GUI_DEFAULT_PERMISSION_MODE); // the mode of the running session
  const [confirmMode, setConfirmMode] = useState<GuiPermissionMode | null>(null); // picked, awaiting the popup answer
  const [pendingSwitch, setPendingSwitch] = useState<GuiPermissionMode | null>(null); // relaunch in flight, committed at ready
  const [busy, setBusy] = useState<BusyState>('idle');

  const termRef = useRef<GuiTerminalHandle>(null);
  const gateRef = useRef<ReadyGate | null>(null);
  const watcherRef = useRef<TrustWatcher | null>(null);
  const busyRef = useRef<BusyGate | null>(null);
  const modeRef = useRef<GuiPermissionMode>(GUI_DEFAULT_PERMISSION_MODE);
  const pendingRef = useRef<GuiPermissionMode | null>(null);
  const hasSentRef = useRef(false);
  const readyRef = useRef(false);
  const resumedStartRef = useRef(false); // the current start asked claude to resume
  const resumeFailures = useRef(0); // consecutive resume starts that ended before ready
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

  const begin = useCallback((opts: boolean | BeginOptions = {}) => {
    const o: BeginOptions = typeof opts === 'boolean' ? { replace: opts } : opts;
    const replace = o.replace === true;
    const gui = window.aetherElectron?.gui;
    const gate = gateRef.current;
    if (!gui || !gate) return;
    watcherRef.current?.reset();
    setTrustShown(false);
    const mySeq = ++startSeq.current;
    gate.reset();
    busyRef.current?.reset();
    readyRef.current = false;
    resumedStartRef.current = o.resume === true;
    clearHint();
    setReady(false);
    setHint(false);
    setError(null);
    setStopped(false);
    cancelHint.current = schedule(() => setHint(true), GUI_NO_OUTPUT_HINT_MS);
    const { cols, rows } = termRef.current?.size() ?? { cols: 80, rows: 24 };
    const fail = (reason: string): void => {
      pendingRef.current = null; // a switch that never started leaves the label on the running mode
      setPendingSwitch(null);
      clearHint();
      setError(FAIL_TEXT[reason] ?? 'Claude could not be started');
      setStopped(true);
      setLiveBoth(false);
    };
    const startMode = o.mode ?? modeRef.current;
    gui.start({ projectId, cols, rows, mode: startMode, ...(replace ? { restart: true } : {}), ...(o.resume === undefined ? {} : { resume: o.resume }) }).then(
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
      onReady: () => {
        readyRef.current = true;
        resumeFailures.current = 0;
        const to = pendingRef.current;
        if (to) {
          pendingRef.current = null;
          modeRef.current = to;
          setMode(to);
          setPendingSwitch(null);
        }
        setReady(true);
      },
    });
    gateRef.current = gate;
    busyRef.current = createBusyGate({
      schedule,
      readScreen: () => termRef.current?.screenText() ?? '',
      onChange: setBusy,
      onSettled: () => {},
      onTrust: () => {},
    });
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
      busyRef.current?.dispose();
      busyRef.current = null;
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
    busyRef.current?.feed();
  }, [clearHint]);

  const sentSomething = useCallback(() => {
    hasSentRef.current = true;
    busyRef.current?.turnStarted();
  }, []);

  const onTyped = useCallback((input: string) => {
    if (/[\r\n]/.test(input)) sentSomething();
  }, [sentSomething]);

  const acceptData = useCallback(() => !dropData.current, []);

  const onExit = useCallback(() => {
    if (!readyRef.current) {
      // Ended before the ready gate: a mode switch that claude refused or a resume that failed.
      const to = pendingRef.current;
      if (to) {
        pendingRef.current = null;
        setPendingSwitch(null);
        setError(`Could not switch to ${MODE_LABELS[to]}; staying on ${MODE_LABELS[modeRef.current]}`);
      }
      if (to || resumedStartRef.current) resumeFailures.current += 1;
    }
    startSeq.current += 1;
    dropData.current = false;
    clearHint();
    gateRef.current?.reset(); // clears pending quiet/ceiling timers
    busyRef.current?.reset();
    watcherRef.current?.reset();
    setTrustShown(false);
    setReady(false);
    setHint(false);
    setStopped(true);
    setLiveBoth(false);
  }, [clearHint, setLiveBoth]);

  const restart = (): void => {
    termRef.current?.reset();
    // Resume the conversation unless it keeps failing to resume: after two failures start fresh, never a dead end.
    const resume = hasSentRef.current && resumeFailures.current < 2;
    if (!resume) hasSentRef.current = false; // a fresh start is a new empty conversation: the next switch must not resume it
    begin({ resume, mode: modeRef.current });
  };

  const confirmSwitch = (): void => {
    const to = confirmMode;
    setConfirmMode(null);
    if (!to || to === modeRef.current) return;
    if (busyRef.current?.state() !== 'idle') return; // a reply started while the popup was open: never kill it on a plain switch
    pendingRef.current = to;
    setPendingSwitch(to);
    dropData.current = true;
    termRef.current?.reset();
    begin({ replace: true, resume: hasSentRef.current, mode: to });
  };

  const onSubmit = async (text: string): Promise<boolean> => {
    try {
      const ok = (await window.aetherElectron?.gui?.submit(text)) === true;
      if (ok) sentSomething();
      return ok;
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
        <GuiTerminal ref={termRef} onChunk={onChunk} onExit={onExit} acceptData={acceptData} onTyped={onTyped} />
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
      {confirmMode && (
        <ConfirmPopup
          message={`Switch to ${MODE_LABELS[confirmMode]}? Claude restarts and may re-read this thread's context.`}
          confirmLabel="Switch"
          onConfirm={confirmSwitch}
          onCancel={() => setConfirmMode(null)}
        />
      )}
      <GuiComposer
        disabled={!enabled}
        placeholder={placeholder}
        onSubmit={onSubmit}
        leading={
          <ModePicker
            mode={pendingSwitch ?? mode}
            disabled={!(enabled && busy === 'idle')}
            hint="Wait for the reply to finish"
            onSelect={(m) => {
              if (m !== (pendingSwitch ?? mode)) setConfirmMode(m);
            }}
          />
        }
      />
    </div>
  );
}
