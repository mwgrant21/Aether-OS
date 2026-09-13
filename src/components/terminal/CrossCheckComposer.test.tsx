import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, useEffect, useState } from 'react';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { CrossCheckComposerProvider, useCrossCheckComposer } from './CrossCheckComposer';

const terminal = vi.hoisted(() => ({ focus: vi.fn() }));
vi.mock('./PtyTerminal', () => ({ focusClaudeTerminal: terminal.focus }));

const base: CommunicationBridgeSnapshot = { enabled: true, readiness: 'ready', cleanup: 'confirmed', metadata: [],
  sessionStatus: { instanceLabel: 'Instance abcdef1234567890', sessionLabel: 'Session 1', client: 'running', connected: true, prompt: 'unknown' } };

function Controls({ snapshot = base }: { snapshot?: CommunicationBridgeSnapshot }) {
  const { state, dispatch } = useAetherStore();
  const composer = useCrossCheckComposer();
  useEffect(() => { dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot }); }, [dispatch, snapshot]);
  return <><button onClick={composer.open}>Cross-check with Codex</button>
    <button onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Settings' })}>Navigate</button>
    <span data-testid="active-tab">{state.activeTab}</span><span data-testid="state-json">{JSON.stringify(state)}</span></>;
}

function view(snapshot = base) {
  return render(<AetherStoreProvider><CrossCheckComposerProvider><Controls snapshot={snapshot} /></CrossCheckComposerProvider></AetherStoreProvider>);
}

function strictView(snapshot = base) {
  return render(<StrictMode><AetherStoreProvider><CrossCheckComposerProvider><Controls snapshot={snapshot} /></CrossCheckComposerProvider></AetherStoreProvider></StrictMode>);
}

function RemovableControls() {
  const { dispatch } = useAetherStore();
  const composer = useCrossCheckComposer();
  const [showTrigger, setShowTrigger] = useState(true);
  useEffect(() => { dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot: base }); }, [dispatch]);
  return <>{showTrigger && <button onClick={() => { composer.open(); setShowTrigger(false); }}>Cross-check with Codex</button>}</>;
}

function install(snapshot: ReturnType<typeof vi.fn>) {
  const startSession = vi.fn(), setEnabled = vi.fn(), grantMore = vi.fn(), write = vi.fn(), start = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: {
    communication: { snapshot, startSession, setEnabled, grantMore }, pty: { write, start },
  } });
  return { startSession, setEnabled, grantMore, write, start };
}

afterEach(() => {
  cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

it('opens and navigates with the draft intact and no launch, grant, model, or terminal side effects', () => {
  const api = install(vi.fn().mockResolvedValue(base));
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Please review this design.' } });
  fireEvent.change(screen.getByLabelText('Cross-check context'), { target: { value: 'Keep this context.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open communication settings' }));
  expect(screen.getByTestId('active-tab').textContent).toBe('Settings');
  expect(screen.getByLabelText('Cross-check question')).toHaveProperty('value', 'Please review this design.');
  expect(screen.getByLabelText('Cross-check context')).toHaveProperty('value', 'Keep this context.');
  expect(api.startSession).not.toHaveBeenCalled(); expect(api.setEnabled).not.toHaveBeenCalled();
  expect(api.grantMore).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(api.write).not.toHaveBeenCalled();
  expect(screen.getByTestId('state-json').textContent).not.toContain('Please review this design.');
});

it('persists normal store state but never the prepared draft or content-derived key', async () => {
  install(vi.fn().mockResolvedValue(base));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  const question = 'persistence-canary-question', context = 'persistence-canary-context';
  const requestKey = createHash('sha256').update(JSON.stringify([question, context])).digest('hex');
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: question } });
  fireEvent.change(screen.getByLabelText('Cross-check context'), { target: { value: context } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 700));
  const persisted = localStorage.getItem('aetheros-v1');
  expect(persisted).not.toBeNull(); expect(persisted).toContain('"activeTab":"Terminal"');
  expect(persisted).not.toContain(question); expect(persisted).not.toContain(context); expect(persisted).not.toContain(requestKey);
  expect(screen.getByTestId('state-json').textContent).not.toContain('persistence-canary');
});

it('moves focus into the question and restores the connected opener on discard', async () => {
  install(vi.fn().mockResolvedValue(base));
  view(); const trigger = screen.getByRole('button', { name: 'Cross-check with Codex' });
  trigger.focus(); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Cross-check question')));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and close cross-check' }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(terminal.focus).not.toHaveBeenCalled();
});

it('does not restore an opener removed by navigation', async () => {
  install(vi.fn().mockResolvedValue(base));
  render(<AetherStoreProvider><CrossCheckComposerProvider><RemovableControls /></CrossCheckComposerProvider></AetherStoreProvider>);
  const trigger = screen.getByRole('button', { name: 'Cross-check with Codex' });
  trigger.focus(); fireEvent.click(trigger);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Cross-check question')));
  expect(trigger.isConnected).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard and close cross-check' }));
  await Promise.resolve(); expect(document.activeElement).not.toBe(trigger); expect(terminal.focus).not.toHaveBeenCalled();
});

it('copies only after two validated observations of the same current launch', async () => {
  const snapshot = vi.fn().mockResolvedValue(base);
  install(snapshot);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Please review this design.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Request copied'));
  expect(snapshot).toHaveBeenCalledTimes(2); expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0][0]).toContain('"question":"Please review this design."');
});

it('retains the draft and reports when the Clipboard API is unavailable', async () => {
  install(vi.fn().mockResolvedValue(base));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Keep unavailable clipboard draft.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Clipboard is unavailable'));
  expect(screen.getByLabelText('Cross-check question')).toHaveProperty('value', 'Keep unavailable clipboard draft.');
  expect(screen.queryByText(/^Request copied/)).toBeNull();
});

it('retains the draft and reports a rejected clipboard write without success', async () => {
  install(vi.fn().mockResolvedValue(base));
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Keep rejected clipboard draft.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Could not copy the request'));
  expect(screen.getByLabelText('Cross-check question')).toHaveProperty('value', 'Keep rejected clipboard draft.');
  expect(screen.queryByText(/^Request copied/)).toBeNull(); expect(writeText).toHaveBeenCalledOnce();
});

it.each([
  ['default-off', { ...base, enabled: false, readiness: 'disabled' as const,
    sessionStatus: { ...base.sessionStatus, sessionLabel: null, client: 'unknown' as const, connected: false, prompt: 'unknown' as const } }, 'Aether bridge unavailable'],
  ['enabled without a launch', { ...base, readiness: 'disconnected' as const,
    sessionStatus: { ...base.sessionStatus, sessionLabel: null, client: 'unknown' as const, connected: false, prompt: 'unknown' as const } }, 'No current connected launch'],
  ['observed exit', { ...base, readiness: 'disconnected' as const,
    sessionStatus: { ...base.sessionStatus, client: 'exited' as const, connected: false, prompt: 'unknown' as const } }, 'has exited'],
] as const)('keeps drafting available but blocks copy when %s', async (_name, snapshotValue, expected) => {
  install(vi.fn().mockResolvedValue(snapshotValue));
  const writeText = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(snapshotValue); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  expect(screen.getByText(new RegExp(expected))).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Draft despite unavailable bridge.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/unavailable|No current connected launch/));
  expect(writeText).not.toHaveBeenCalled();
});

it.each([
  ['starting with trust prompt', { ...base, readiness: 'waiting' as const,
    sessionStatus: { ...base.sessionStatus, client: 'starting' as const, prompt: 'folder-trust' as const } }],
  ['running with helper readiness disconnected', { ...base, readiness: 'disconnected' as const }],
] as const)('permits local copy for a current launch that is %s', async (_name, snapshotValue) => {
  install(vi.fn().mockResolvedValue(snapshotValue));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(snapshotValue); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Copy is local, not paste authorization.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
});

it('reports honestly when the launch is replaced after the clipboard succeeds', async () => {
  const replacement = { ...base, sessionStatus: { ...base.sessionStatus, sessionLabel: 'Session 2' } };
  install(vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce(replacement));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Check replacement after copy.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Request copied, but'));
  expect(writeText).toHaveBeenCalledOnce();
});

it('reports copied-but-unverified when the post-copy snapshot fails', async () => {
  install(vi.fn().mockResolvedValueOnce(base).mockRejectedValueOnce(new Error('offline')));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Check post-copy failure.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Request copied, but the current launch could not be verified'));
});

it('retains the draft and requires explicit review when the current launch was replaced', async () => {
  const replacement = { ...base, sessionStatus: { ...base.sessionStatus, sessionLabel: 'Session 2' } };
  install(vi.fn().mockResolvedValue(replacement));
  const writeText = vi.fn(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Please review this design.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('target changed'));
  expect(writeText).not.toHaveBeenCalled(); expect(screen.getByLabelText('Cross-check question')).toHaveProperty('value', 'Please review this design.');
  expect(screen.getByText(/Proposed: Instance abcdef1234567890 · Session 2/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review current target' }));
  expect(screen.getByText(/repeated key is scoped to this launch/)).toBeTruthy();
});

it('focuses a validated current launch without writing or starting the terminal', async () => {
  const api = install(vi.fn().mockResolvedValue(base));
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
  await waitFor(() => expect(terminal.focus).toHaveBeenCalledOnce());
  expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
  expect(api.write).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('supports copy and focus after StrictMode effect replay', async () => {
  const api = install(vi.fn().mockResolvedValue(base));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  strictView(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'StrictMode ownership check.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
  await waitFor(() => expect(terminal.focus).toHaveBeenCalledOnce());
  expect(api.write).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('does not focus after close while the target refresh is pending', async () => {
  let resolve!: (value: CommunicationBridgeSnapshot) => void;
  const pending = new Promise<CommunicationBridgeSnapshot>(yes => { resolve = yes; });
  const api = install(vi.fn(() => pending));
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard and close cross-check' }));
  resolve(base); await pending; await Promise.resolve();
  expect(terminal.focus).not.toHaveBeenCalled(); expect(api.write).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('suppresses stale copy success after an edit while the clipboard write is pending', async () => {
  let resolve!: () => void;
  const clipboard = new Promise<void>(yes => { resolve = yes; });
  install(vi.fn().mockResolvedValue(base));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => clipboard) } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Please review this design.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Changed while copying.' } });
  resolve(); await waitFor(() => expect(screen.getByRole('button', { name: 'Copy request' }).hasAttribute('disabled')).toBe(false));
  expect(screen.queryByText(/Request copied/)).toBeNull();
});

it('keeps clipboard writes serialized across close and reopen', async () => {
  let resolve!: () => void;
  const clipboard = new Promise<void>(yes => { resolve = yes; });
  install(vi.fn().mockResolvedValue(base));
  const writeText = vi.fn(() => clipboard);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'First pending copy.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Discard and close cross-check' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  expect(screen.getByRole('button', { name: 'Copy request' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' })); expect(writeText).toHaveBeenCalledOnce();
  resolve(); await waitFor(() => expect(screen.getByRole('button', { name: 'Copy request' }).hasAttribute('disabled')).toBe(false));
});

it('discards explicitly and starts empty after a provider remount', () => {
  install(vi.fn().mockResolvedValue(base));
  const mounted = view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Transient only.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard and close cross-check' }));
  expect(screen.queryByLabelText('Cross-check question')).toBeNull();
  mounted.unmount(); view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  expect(screen.getByLabelText('Cross-check question')).toHaveProperty('value', '');
});

it('abandons a pending clipboard continuation when its React owner unmounts', async () => {
  let resolve!: () => void;
  const clipboard = new Promise<void>(yes => { resolve = yes; });
  const snapshot = vi.fn().mockResolvedValue(base);
  install(snapshot);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(() => clipboard) } });
  const mounted = view(); fireEvent.click(screen.getByRole('button', { name: 'Cross-check with Codex' }));
  fireEvent.change(screen.getByLabelText('Cross-check question'), { target: { value: 'Pending owner operation.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy request' }));
  await waitFor(() => expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce());
  mounted.unmount(); resolve(); await clipboard; await Promise.resolve();
  expect(snapshot).toHaveBeenCalledTimes(1);
});
