import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import { CrossCheckIntentOwner } from '../../shared/crossCheckIntent';
import { communicationClientCopy } from '../../shared/communicationClientCopy';
import { projectCommunicationSnapshot } from '../../shared/communicationSnapshot';
import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { focusClaudeTerminal } from './PtyTerminal';

interface ComposerContextValue { open: () => void; }
const ComposerContext = createContext<ComposerContextValue | null>(null);

export function useCrossCheckComposer() {
  const value = useContext(ComposerContext);
  if (!value) throw new Error('useCrossCheckComposer must be used within CrossCheckComposerProvider');
  return value;
}

function targetOf(snapshot: CommunicationBridgeSnapshot | null) {
  const status = snapshot?.sessionStatus;
  return status?.sessionLabel ? { instanceLabel: status.instanceLabel, sessionLabel: status.sessionLabel } : null;
}

function sameTarget(a: ReturnType<typeof targetOf>, b: ReturnType<typeof targetOf>) {
  if (!a || !b) return a === b;
  return a.instanceLabel === b.instanceLabel && a.sessionLabel === b.sessionLabel;
}

function eligible(snapshot: CommunicationBridgeSnapshot | null) {
  return !!snapshot?.enabled && snapshot.sessionStatus.connected
    && snapshot.sessionStatus.client !== 'exited' && snapshot.sessionStatus.client !== 'failed';
}

export function CrossCheckComposerProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const owner = useRef(new CrossCheckIntentOwner()).current;
  const alive = useRef(true);
  const visibleRef = useRef(false);
  const operation = useRef(0);
  const operationBusy = useRef(false);
  const busyToken = useRef<number | null>(null);
  const reviewedTarget = useRef<ReturnType<typeof targetOf>>(null);
  const opener = useRef<HTMLElement | null>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const [visible, setVisible] = useState(false);
  const [question, setQuestion] = useState('');
  const [context, setContext] = useState('');
  const [target, setTarget] = useState<ReturnType<typeof targetOf>>(null);
  const [candidate, setCandidate] = useState<CommunicationBridgeSnapshot | null>(null);
  const [busy, setBusy] = useState<'copy' | 'focus' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; visibleRef.current = false; operation.current++; operationBusy.current = false; busyToken.current = null; owner.discard();
    };
  }, [owner]);

  useEffect(() => {
    if (visible) questionInput.current?.focus();
  }, [visible]);

  const open = useCallback(() => {
    if (visibleRef.current) return;
    const initialTarget = targetOf(state.communicationSnapshot);
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visibleRef.current = true; reviewedTarget.current = initialTarget;
    setVisible(true); setTarget(initialTarget); setCandidate(null); setMessage(null);
  }, [state.communicationSnapshot]);
  const revise = (nextQuestion: string, nextContext: string) => {
    operation.current++;
    setQuestion(nextQuestion); setContext(nextContext);
    owner.revise(nextQuestion, nextContext || undefined);
    setMessage(null);
  };
  const close = () => {
    const restore = opener.current;
    operation.current++; visibleRef.current = false; reviewedTarget.current = null;
    opener.current = null;
    owner.discard(); setVisible(false); setQuestion(''); setContext(''); setTarget(null); setCandidate(null);
    if (!operationBusy.current) setBusy(null);
    setMessage(null);
    queueMicrotask(() => { if (restore?.isConnected) restore.focus(); });
  };
  const fresh = async () => {
    const api = window.aetherElectron?.communication;
    return api ? projectCommunicationSnapshot(await api.snapshot()) : null;
  };
  const requireCurrentTarget = (current: CommunicationBridgeSnapshot | null, token: number) => {
    if (!alive.current || operation.current !== token || !visibleRef.current) return false;
    if (!current || !eligible(current)) {
      setCandidate(current);
      setMessage(current?.enabled
        ? 'No current connected launch is available. The draft is preserved; review the terminal or start a session from Settings.'
        : 'Aether bridge unavailable. The draft is preserved; enable communication and start a session from Settings.');
      return false;
    }
    if (!sameTarget(reviewedTarget.current, targetOf(current))) {
      setCandidate(current); setMessage('The launch target changed. Review the current target before copying or focusing.');
      return false;
    }
    return true;
  };
  const begin = (kind: 'copy' | 'focus') => {
    if (operationBusy.current) return null;
    operationBusy.current = true;
    const token = ++operation.current;
    busyToken.current = token;
    setBusy(kind); setMessage(null);
    return token;
  };
  const currentOperation = (token: number, capturedRevision?: number, capturedTarget?: ReturnType<typeof targetOf>) =>
    alive.current && visibleRef.current && operation.current === token
      && (capturedRevision === undefined || owner.snapshot().revision === capturedRevision)
      && (capturedTarget === undefined || sameTarget(capturedTarget, reviewedTarget.current));
  const finish = (token: number) => {
    if (busyToken.current !== token) return;
    operationBusy.current = false; busyToken.current = null;
    if (alive.current) setBusy(null);
  };
  const copy = async () => {
    const token = begin('copy');
    if (token === null) return;
    const capturedRevision = owner.snapshot().revision;
    const capturedTarget = reviewedTarget.current;
    try {
      const current = await fresh();
      if (!currentOperation(token, capturedRevision, capturedTarget)) return;
      if (!requireCurrentTarget(current, token)) return;
      const prepared = await owner.prepare();
      if (!currentOperation(token, capturedRevision, capturedTarget)) return;
      if (prepared.status === 'stale' || prepared.revision !== capturedRevision) return;
      if (prepared.status === 'error') {
        setMessage(prepared.code === 'INPUT_LIMIT' ? 'Question or context exceeds the supported UTF-8 byte limit.'
          : prepared.code === 'INVALID_INPUT' ? 'Enter a non-empty question.' : 'Could not prepare this request.');
        return;
      }
      if (!navigator.clipboard?.writeText) { setMessage('Clipboard is unavailable. The draft is preserved.'); return; }
      await navigator.clipboard.writeText(prepared.text);
      if (!currentOperation(token, capturedRevision, capturedTarget)) return;
      let after: CommunicationBridgeSnapshot | null;
      try { after = await fresh(); }
      catch {
        if (currentOperation(token, capturedRevision, capturedTarget))
          setMessage('Request copied, but the current launch could not be verified afterward. Review the target before pasting.');
        return;
      }
      if (!currentOperation(token, capturedRevision, capturedTarget)) return;
      if (!after) {
        setMessage('Request copied, but the current launch could not be verified afterward. Review the target before pasting.');
      } else if (!sameTarget(capturedTarget, targetOf(after)) || !eligible(after)) {
        setCandidate(after); setMessage('Request copied, but the connected launch changed afterward. Review the current target before pasting.');
      } else setMessage('Request copied. Review the terminal before you paste and submit it.');
    } catch {
      if (currentOperation(token, capturedRevision, capturedTarget)) setMessage('Could not copy the request. The draft is preserved.');
    } finally { finish(token); }
  };
  const focus = async () => {
    const token = begin('focus');
    if (token === null) return;
    const capturedTarget = reviewedTarget.current;
    try {
      const current = await fresh();
      if (!currentOperation(token, undefined, capturedTarget)) return;
      if (!requireCurrentTarget(current, token)) return;
      if (!currentOperation(token, undefined, capturedTarget)) return;
      focusClaudeTerminal(); dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' });
      setMessage('Terminal focused. Nothing was pasted or submitted.');
    } catch { if (currentOperation(token, undefined, capturedTarget)) setMessage('Could not check the current launch. The draft is preserved.'); }
    finally { finish(token); }
  };
  const reviewCandidate = () => {
    if (!candidate || !eligible(candidate)) return;
    const nextTarget = targetOf(candidate);
    reviewedTarget.current = nextTarget; setTarget(nextTarget); setCandidate(null);
    setMessage('Current target reviewed. A repeated key is scoped to this launch and may start a new consultation after replacement.');
  };

  return <ComposerContext.Provider value={{ open }}>
    {children}
    {visible && <section aria-label="Cross-check with Codex" style={panelStyle(colors)}>
      <div style={headingStyle}>
        <div><strong style={{ color: colors.textPrimary }}>Cross-check with Codex</strong>
          <div style={{ color: colors.textDim, fontSize: 11 }}>Copy an explicit bridge request, then decide whether to paste it.</div></div>
        <Button aria-label="Discard and close cross-check" onClick={close} style={{ color: colors.textSecondary, padding: 6 }}>Discard ×</Button>
      </div>
      <div style={targetStyle(colors)}>
        <span>Target: {target ? `${target.instanceLabel} · ${target.sessionLabel}` : 'No session selected'}</span>
        {candidate && eligible(candidate) && <span>Proposed: {candidate.sessionStatus.instanceLabel} · {candidate.sessionStatus.sessionLabel}</span>}
        {candidate && eligible(candidate) && <Button onClick={reviewCandidate} style={smallButtonStyle(colors)}>Review current target</Button>}
      </div>
      <div style={{ color: colors.textSecondary }}>
        {communicationClientCopy(state.communicationSnapshot)?.detail
          ?? (!state.communicationSnapshot?.enabled
          ? 'Aether bridge unavailable. You can draft now; enable communication and start a connected session from Settings before copying.'
          : !state.communicationSnapshot.sessionStatus.connected
            ? 'No current connected launch. Start or review the session from Settings; drafting remains available.'
            : 'Current launch detected. Bridge readiness does not prove the terminal is ready for input.')}
      </div>
      <label style={labelStyle}>Question
        <textarea ref={questionInput} aria-label="Cross-check question" value={question} onChange={event => revise(event.target.value, context)} rows={3} style={inputStyle(colors)} />
      </label>
      <label style={labelStyle}>Context (optional)
        <textarea aria-label="Cross-check context" value={context} onChange={event => revise(question, event.target.value)} rows={3} style={inputStyle(colors)} />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button onClick={copy} disabled={!!busy} style={actionStyle(colors)}>Copy request</Button>
        <Button onClick={focus} disabled={!!busy} style={smallButtonStyle(colors)}>Focus connected terminal</Button>
        <Button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Settings' })} style={smallButtonStyle(colors)}>Open communication settings</Button>
      </div>
      {message && <div role="status" aria-live="polite" style={{ color: colors.textSecondary }}>{message}</div>}
    </section>}
  </ComposerContext.Provider>;
}

function panelStyle(colors: ReturnType<typeof useColors>): CSSProperties { return { position: 'absolute', zIndex: 20, right: 28, bottom: 54,
  width: 'min(520px, calc(100% - 56px))', maxHeight: 'calc(100% - 110px)', overflowY: 'auto', boxSizing: 'border-box', padding: 16,
  border: `1px solid ${colors.activeBorder}`, borderRadius: 12, background: colors.bgBase, boxShadow: '0 16px 48px rgba(0,0,0,.55)',
  color: colors.textBody, font: `13px/1.4 ${fonts.ui}`, display: 'flex', flexDirection: 'column', gap: 10 }; }
const headingStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' };
function targetStyle(colors: ReturnType<typeof useColors>): CSSProperties { return { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between',
  padding: 8, borderRadius: 7, background: colors.panelInset, color: colors.textSecondary, font: `11px/1.4 ${fonts.mono}` }; }
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
function inputStyle(colors: ReturnType<typeof useColors>): CSSProperties { return { resize: 'vertical', minHeight: 58, boxSizing: 'border-box', padding: 8,
  borderRadius: 6, border: `1px solid ${colors.panelBorder}`, background: colors.panelInset, color: colors.textBody, font: `12px/1.4 ${fonts.mono}` }; }
function smallButtonStyle(colors: ReturnType<typeof useColors>): CSSProperties { return { padding: '6px 9px', borderRadius: 6,
  border: `1px solid ${colors.panelBorder}`, color: colors.textSecondary }; }
function actionStyle(colors: ReturnType<typeof useColors>): CSSProperties { return { ...smallButtonStyle(colors), borderColor: colors.activeBorder, color: colors.accentCyan }; }
