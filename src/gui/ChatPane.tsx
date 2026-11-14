import { useCallback, useEffect, useRef, useState } from 'react';
import { GUI_NEW_KEY, GUI_NO_OUTPUT_HINT_MS, type GuiPermissionMode, type StartResult } from '../../electron/gui/guiTypes';
import { Button } from '../components/shared/Button';
import { useColors } from '../components/shared/useColors';
import { fonts, radii } from '../styles/tokens';
import { GUI_BG_MARKER_RELIABLE, createBusyGate, type BusyGate, type BusyState } from './busyGate';
import { ConfirmPopup } from './ConfirmPopup';
import { GuiComposer } from './GuiComposer';
import { GuiTerminal, type GuiTerminalHandle } from './GuiTerminal';
import { MODE_LABELS, ModePicker } from './ModePicker';
import { createInputBoxGate, type InputBoxGate } from './inputBox';
import { createReadyGate, type ReadyGate } from './readyGate';
import { createTrustWatcher, isTrustPromptText, type TrustWatcher } from './trustPrompt';
import { useGuiProjects } from './useGuiProjects';

export interface ChatPaneStatus {
  live: boolean;
  state: BusyState;
  /** false = the busy gate's canary decided it cannot see Claude's working screen. */
  trusted: boolean;
  /** The chat holds a conversation (a turn was sent, or this pane resumed one). */
  hasSent: boolean;
  /** The busy gate settled (idle, then quiet and idle again): a finished chat. */
  settled: boolean;
}

interface ChatPaneProps {
  projectId: string | null;
  /** false = hidden (display:none) but still mounted: the terminal keeps absorbing output and the gates keep running. */
  active: boolean;
  /** The first start resumes the conversation of this chat. */
  resume?: boolean;
  /** Permission mode, owned by the parent so it survives an idle-stop and return. */
  mode: GuiPermissionMode;
  onModeChange: (mode: GuiPermissionMode) => void;
  onStatus: (status: ChatPaneStatus) => void;
  onLiveChange?: (live: boolean) => void;
  /** Offered (as a Stop chat button) only while auto-stop is off and the chat holds a conversation. */
  onStopChat?: () => void;
}

const FAIL_TEXT: Record<string, string> = {
  'missing-dir': 'That folder no longer exists',
  unavailable: 'Folder storage is not available this run',
  'unknown-project': 'That project is no longer pinned',
  'spawn-failed': 'Claude could not be started',
  'bad-request': 'Claude could not be started',
  'too-many-live': 'Too many chats are working. Wait for one to finish.',
};

interface BeginOptions {
  replace?: boolean;
  resume?: boolean;
  mode?: GuiPermissionMode;
  modeSwitch?: boolean; // this launch is a permission-mode switch: its failure keeps the switch's own revert path
  noRetry?: boolean; // a user-initiated start: a resume that fails is not retried fresh here (Restart has its own rule)
  fallbackNote?: boolean; // this start is the automatic fresh retry of a failed resume
}

const TAIL_CAP = 2000;
// claude's own message when the conversation to resume does not exist (ANSI stripped, last 400 chars only).
function resumeFailedText(tail: string): boolean {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences
  const plain = tail.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ');
  return /No conversation found/i.test(plain.slice(-400));
}

const schedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function ChatPane({ projectId, active, resume, mode, onModeChange, onStatus, onLiveChange, onStopChat }: ChatPaneProps) {
  const colors = useColors();
  const { projects } = useGuiProjects();
  const sessionKey = projectId ?? GUI_NEW_KEY;
  const name = projectId === null ? 'New chat' : (projects.find((p) => p.id === projectId)?.name ?? 'Project');

  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [boxSeen, setBoxSeen] = useState(false); // claude's input box has been drawn (or the ceiling passed) this start
  const [hint, setHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [trustShown, setTrustShown] = useState(false);
  const [resumeNote, setResumeNote] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [confirmMode, setConfirmMode] = useState<GuiPermissionMode | null>(null); // picked, awaiting the popup answer
  const [pendingSwitch, setPendingSwitch] = useState<GuiPermissionMode | null>(null); // relaunch in flight, committed at ready
  const [busy, setBusy] = useState<BusyState>('idle');
  const [busyTrusted, setBusyTrusted] = useState(true);
  const [settled, setSettled] = useState(false);
  const [hasSent, setHasSent] = useState(resume === true); // a resumed pane already holds a conversation

  const termRef = useRef<GuiTerminalHandle>(null);
  const gateRef = useRef<ReadyGate | null>(null);
  const boxGateRef = useRef<InputBoxGate | null>(null);
  const watcherRef = useRef<TrustWatcher | null>(null);
  const busyRef = useRef<BusyGate | null>(null);
  const modeRef = useRef<GuiPermissionMode>(mode); // the mode of the running session
  const firstStart = useRef({ resume, mode });
  const pendingRef = useRef<GuiPermissionMode | null>(null);
  const hasSentRef = useRef(resume === true);
  const readyRef = useRef(false);
  const resumedStartRef = useRef(false); // the current start asked claude to resume
  const trustShownRef = useRef(false); // claude's trust prompt is on screen (mirrors trustShown for onTyped)
  const tailRef = useRef(''); // bounded tail of the current start's raw output
  const turnSentThisStart = useRef(false); // a turn was submitted or typed since the current start began
  const modeSwitchRef = useRef(false); // the current start is a mode switch; survives onReady, reset by the next start
  const retryFreshRef = useRef(false); // the current start was a resume that may be retried fresh once if it ends before ready
  const resumeFailures = useRef(0); // consecutive resume starts that ended before ready
  const mounted = useRef(false);
  const startSeq = useRef(0);
  const restartedOnReuse = useRef(false); // a reused start restarts the session at most once per mount
  const dropData = useRef(false); // true from a reused reply until the restart's own start reply: old-PTY output in flight must not reach the new gate
  const cancelHint = useRef<(() => void) | null>(null);
  const onLiveChangeRef = useRef(onLiveChange);
  onLiveChangeRef.current = onLiveChange;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    onStatusRef.current({ live, state: busy, trusted: busyTrusted, hasSent, settled });
  }, [live, busy, busyTrusted, hasSent, settled]);

  const setLiveBoth = useCallback((v: boolean) => {
    setLive(v);
    onLiveChangeRef.current?.(v);
  }, []);

  const clearHint = useCallback(() => {
    cancelHint.current?.();
    cancelHint.current = null;
  }, []);

  const setTrustShownBoth = useCallback((v: boolean) => {
    trustShownRef.current = v;
    setTrustShown(v);
  }, []);

  const begin = useCallback((opts: boolean | BeginOptions = {}) => {
    const o: BeginOptions = typeof opts === 'boolean' ? { replace: opts } : opts;
    const replace = o.replace === true;
    const gui = window.aetherElectron?.gui;
    const gate = gateRef.current;
    if (!gui || !gate) return;
    watcherRef.current?.reset();
    setTrustShownBoth(false);
    const mySeq = ++startSeq.current;
    gate.reset();
    boxGateRef.current?.reset();
    setBoxSeen(false);
    busyRef.current?.reset();
    setSettled(false);
    readyRef.current = false;
    tailRef.current = '';
    turnSentThisStart.current = false;
    resumedStartRef.current = o.resume === true;
    modeSwitchRef.current = o.modeSwitch === true;
    retryFreshRef.current = o.resume === true && o.noRetry !== true;
    setResumeNote(o.fallbackNote === true);
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
        if (!r.ok) {
          if (r.reason === 'superseded') return; // a later start/stop replaced the session this reply was for: nothing to show
          return fail(r.reason);
        }
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
  }, [projectId, clearHint, setLiveBoth, setTrustShownBoth]);

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
          onModeChangeRef.current(to);
          setPendingSwitch(null);
        }
        setReady(true);
      },
    });
    gateRef.current = gate;
    const boxGate = createInputBoxGate({
      schedule,
      readScreen: () => termRef.current?.screenText() ?? '',
      onVisible: () => setBoxSeen(true),
    });
    boxGateRef.current = boxGate;
    busyRef.current = createBusyGate({
      schedule,
      readScreen: () => termRef.current?.screenText() ?? '',
      onChange: (s) => {
        setBusy(s);
        if (s !== 'idle') setSettled(false);
      },
      onSettled: () => setSettled(true),
      onTrust: setBusyTrusted,
    });
    watcherRef.current = createTrustWatcher({
      schedule,
      readScreen: () => termRef.current?.screenText() ?? '',
      onChange: setTrustShownBoth,
    });
    // Deferred so StrictMode's discarded first run never reaches gui.start (a second start would be
    // answered reused:true and force the composer ready); the child has subscribed onData by then.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) begin({ resume: firstStart.current.resume, mode: firstStart.current.mode });
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearHint();
      gate.dispose();
      gateRef.current = null;
      boxGate.dispose();
      boxGateRef.current = null;
      busyRef.current?.dispose();
      busyRef.current = null;
      watcherRef.current?.dispose();
      watcherRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ChatPane is keyed by projectId: one start per mount
  }, []);

  const onChunk = useCallback((d: string) => {
    tailRef.current = (tailRef.current + d).slice(-TAIL_CAP);
    clearHint();
    setHint(false);
    gateRef.current?.feed();
    boxGateRef.current?.feed();
    watcherRef.current?.feed();
    busyRef.current?.feed();
  }, [clearHint]);

  const sentSomething = useCallback(() => {
    turnSentThisStart.current = true;
    hasSentRef.current = true;
    setHasSent(true);
    busyRef.current?.turnStarted();
  }, []);

  const onTyped = useCallback((input: string) => {
    // The Enter that answers claude's folder-trust prompt is not a message. The watcher's shown flag stays set until
    // 1.5 s of silence, so ask the live screen whether the dialog is still up.
    const answeringTrust = trustShownRef.current && isTrustPromptText(termRef.current?.screenText() ?? '');
    if (/[\r\n]/.test(input) && !answeringTrust) sentSomething();
  }, [sentSomething]);

  const acceptData = useCallback(() => !dropData.current, []);

  const onExit = useCallback(() => {
    let retryFresh = false;
    // The gate can fire on shell quiet, and if it does so before claude prints its error, a resume failure is also read from the output.
    const textFail =
      resumedStartRef.current && !modeSwitchRef.current && !turnSentThisStart.current && resumeFailedText(tailRef.current);
    if (!readyRef.current) {
      // Ended before the ready gate: a mode switch that claude refused or a resume that failed.
      const to = pendingRef.current;
      if (to) {
        pendingRef.current = null;
        setPendingSwitch(null);
        setError(`Could not switch to ${MODE_LABELS[to]}; staying on ${MODE_LABELS[modeRef.current]}`);
      }
      if (to || resumedStartRef.current) resumeFailures.current += 1;
      retryFresh = !to && retryFreshRef.current;
    } else if (textFail) {
      resumeFailures.current += 1;
      retryFresh = retryFreshRef.current;
    }
    if (textFail && !retryFresh) {
      // A failed resume is definitive: no automatic retry here (Restart owns it), and the next Restart starts fresh.
      resumeFailures.current = 2;
      hasSentRef.current = false;
      setHasSent(false);
    }
    startSeq.current += 1;
    dropData.current = false;
    clearHint();
    gateRef.current?.reset(); // clears pending quiet/ceiling timers
    boxGateRef.current?.reset();
    setBoxSeen(false);
    busyRef.current?.reset();
    setSettled(false);
    watcherRef.current?.reset();
    setTrustShownBoth(false);
    setReady(false);
    setHint(false);
    setStopped(true);
    setLiveBoth(false);
    if (retryFresh) {
      // A resume that could not reopen the conversation (ended before ready, or printed "No conversation found"): start a new one, once.
      hasSentRef.current = false;
      setHasSent(false);
      dropData.current = true;
      termRef.current?.reset();
      begin({ replace: true, resume: false, mode: modeRef.current, fallbackNote: true });
    }
  }, [clearHint, setLiveBoth, begin, setTrustShownBoth]);

  const restart = (): void => {
    termRef.current?.reset();
    // Resume the conversation unless it keeps failing to resume: after two failures start fresh, never a dead end.
    const resume = hasSentRef.current && resumeFailures.current < 2;
    if (!resume) {
      // a fresh start is a new empty conversation: the next switch must not resume it
      hasSentRef.current = false;
      setHasSent(false);
    }
    begin({ resume, mode: modeRef.current, noRetry: true });
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
    begin({ replace: true, resume: hasSentRef.current, mode: to, modeSwitch: true });
  };

  const confirmFreshStart = (): void => {
    setConfirmFresh(false);
    if (busyRef.current?.state() !== 'idle') return; // a reply started while the popup was open: never kill it on a plain action
    dropData.current = true;
    termRef.current?.reset();
    hasSentRef.current = false;
    setHasSent(false);
    begin({ replace: true, resume: false, mode: modeRef.current, noRetry: true });
  };

  const onSubmit = async (text: string): Promise<boolean> => {
    try {
      const ok = (await window.aetherElectron?.gui?.submit(sessionKey, text)) === true;
      if (ok) sentSomething();
      return ok;
    } catch {
      return false;
    }
  };

  const enabled = live && ready && boxSeen && !trustShown;
  const placeholder = stopped
    ? 'Claude is not running'
    : trustShown
      ? 'Waiting for your answer in the pane'
      : !enabled
        ? 'Starting Claude...'
        : 'Message Claude';
  const autoStopOff = !busyTrusted || !GUI_BG_MARKER_RELIABLE;
  const canStopChat = onStopChat !== undefined && autoStopOff && hasSent && live;
  const hintText = hint && !ready && !error ? 'No output from Claude yet. Type in the pane.' : null;
  const message =
    error ??
    (trustShown
      ? "Answer Claude's trust prompt in the pane first"
      : resumeNote
        ? 'Could not resume the previous conversation; started a new one.'
        : (hintText ?? (!busyTrusted ? "Auto-stop is off: Aether could not recognise Claude's working screen." : null)));

  return (
    <div data-testid="chat-pane" style={{ display: active ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 24px' }}>
        <span style={{ color: colors.textPrimary, font: `600 16px/1.3 ${fonts.ui}` }}>{name}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {projectId === null && (
          <Button
            onClick={() => setConfirmFresh(true)}
            disabled={busy !== 'idle'}
            title={busy !== 'idle' ? 'Wait for the reply to finish' : undefined}
            style={{ font: `600 13px/1 ${fonts.ui}`, color: colors.accentCyan, padding: '4px 6px' }}
            hoverStyle={{ color: colors.textPrimary }}
          >
            Start fresh
          </Button>
        )}
        {canStopChat && (
          <Button
            onClick={onStopChat}
            style={{ font: `600 13px/1 ${fonts.ui}`, color: colors.accentCyan, padding: '4px 6px' }}
            hoverStyle={{ color: colors.textPrimary }}
          >
            Stop chat
          </Button>
        )}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <GuiTerminal ref={termRef} sessionKey={sessionKey} onChunk={onChunk} onExit={onExit} acceptData={acceptData} onTyped={onTyped} />
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
      {confirmFresh && (
        <ConfirmPopup
          message="Start a fresh conversation? The current one stays in Claude's history; this window will not reopen it."
          confirmLabel="Start fresh"
          confirmOnEnter
          onConfirm={confirmFreshStart}
          onCancel={() => setConfirmFresh(false)}
        />
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
