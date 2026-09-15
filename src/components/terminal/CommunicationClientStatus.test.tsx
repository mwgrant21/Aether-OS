import { afterEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import { CommunicationClientStatus } from './CommunicationClientStatus';
const terminal = vi.hoisted(() => ({ focus: vi.fn() }));
vi.mock('./PtyTerminal', () => ({ focusClaudeTerminal: terminal.focus }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
const base: CommunicationBridgeSnapshot = { enabled: true, readiness: 'waiting', cleanup: 'confirmed', metadata: [],
  sessionStatus: { instanceLabel: 'Instance abcdef1234567890', sessionLabel: 'Session 1', client: 'starting', connected: true, prompt: 'folder-trust' } };
function Harness({ snapshot }: { snapshot: CommunicationBridgeSnapshot }) {
  const { state, dispatch } = useAetherStore();
  useEffect(() => { dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Settings' }); dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot }); }, [dispatch, snapshot]);
  return <><CommunicationClientStatus /><span data-testid="active-tab">{state.activeTab}</span></>;
}
function install(snapshot: () => Promise<CommunicationBridgeSnapshot>) {
  const start = vi.fn(), write = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { communication: { snapshot, startSession: start }, pty: { start, write } } });
  return { start, write };
}
it('focuses only the same displayed session, without starting or writing', async () => {
  const api = install(async () => base);
  render(<AetherStoreProvider><Harness snapshot={base} /></AetherStoreProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
  await waitFor(() => expect(terminal.focus).toHaveBeenCalledOnce());
  expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
  expect(api.start).not.toHaveBeenCalled(); expect(api.write).not.toHaveBeenCalled();
});
it('refuses stale session or instance focus and reports snapshot failure', async () => {
  const read = vi.fn().mockResolvedValueOnce({ ...base, sessionStatus: { ...base.sessionStatus, sessionLabel: 'Session 2' } })
    .mockResolvedValueOnce({ ...base, sessionStatus: { ...base.sessionStatus, instanceLabel: 'Instance 1111111111111111' } })
    .mockRejectedValueOnce(new Error('offline'));
  install(read);
  render(<AetherStoreProvider><Harness snapshot={base} /></AetherStoreProvider>);
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('session changed'));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Focus connected terminal' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not check'));
  expect(terminal.focus).not.toHaveBeenCalled();
  expect(screen.getByTestId('active-tab').textContent).toBe('Settings');
});
it('replaces actionable text with generic status then positive exit, without retaining the old banner', () => {
  const view = render(<AetherStoreProvider><Harness snapshot={base} /></AetherStoreProvider>);
  expect(screen.getByRole('status').textContent).toContain('Action required: folder trust');
  view.rerender(<AetherStoreProvider><Harness snapshot={{ ...base, sessionStatus: { ...base.sessionStatus, prompt: 'unknown' } }} /></AetherStoreProvider>);
  expect(screen.getByRole('status').textContent).toContain('Client not ready');
  expect(screen.queryByText('Action required: folder trust')).toBeNull();
  view.rerender(<AetherStoreProvider><Harness snapshot={{ ...base, readiness: 'disconnected', sessionStatus: { ...base.sessionStatus, client: 'exited', connected: false, prompt: 'unknown' } }} /></AetherStoreProvider>);
  expect(screen.getByRole('status').textContent).toContain('Client exited');
});
