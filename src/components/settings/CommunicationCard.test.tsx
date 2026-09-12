import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { CommunicationCard } from './CommunicationCard';
const terminal = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../terminal/PtyTerminal', () => ({ prepareClaudeTerminal: terminal.prepare }));
afterEach(() => { cleanup(); localStorage.clear(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
it('shows a default-off preference and no invented readiness', () => {
  render(<AetherStoreProvider><CommunicationCard /></AetherStoreProvider>);
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('status unavailable');
  expect(screen.getByText(/does not launch a session/)).toBeTruthy();
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('status unavailable');
});

function EnabledCard({ pending = false, ready = false, stopped = false, credits }: { pending?: boolean; ready?: boolean; stopped?: boolean; credits?: number }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_COMMUNICATION_CFG', enabled: true });
    dispatch({ type: 'SET_COMMUNICATION_SNAPSHOT', snapshot: {
      enabled: !stopped, readiness: stopped ? 'disabled' : ready ? 'ready' : 'waiting', cleanup: pending ? 'pending' : 'confirmed', metadata: [], remainingCredits: credits,
    } });
  }, [dispatch, pending, ready, stopped, credits]);
  return <CommunicationCard />;
}
it('requires enabled main state and confirmed cleanup before launch', () => {
  render(<AetherStoreProvider><EnabledCard pending /></AetherStoreProvider>);
  expect((screen.getByRole('button', { name: 'Start fresh connected Claude' }) as HTMLButtonElement).disabled).toBe(true);
});

it('separates saved enabled preference from a stopped bridge during cleanup', () => {
  render(<AetherStoreProvider><EnabledCard stopped pending /></AetherStoreProvider>);
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Preference saved. Bridge stopped while cleanup finishes/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Start fresh connected Claude' }) as HTMLButtonElement).disabled).toBe(true);
});

it('grants once during confirmation without launching or inventing credits', async () => {
  let resolve!: (result: { ok: boolean }) => void;
  const grantMore = vi.fn(() => new Promise(r => { resolve = r; }));
  const startSession = vi.fn();
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { communication: { grantMore, startSession } } });
  render(<AetherStoreProvider><EnabledCard ready credits={0} /></AetherStoreProvider>);
  expect(screen.getByText('Consultation credits remaining: 0.')).toBeTruthy();
  const button = screen.getByRole('button', { name: 'Grant 3 more consultations' });
  fireEvent.click(button); fireEvent.click(button);
  expect(grantMore).toHaveBeenCalledTimes(1);
  expect(grantMore.mock.calls[0]).toEqual([expect.stringMatching(/^[a-f0-9-]{36}$/)]);
  expect(startSession).not.toHaveBeenCalled();
  await act(async () => resolve({ ok: true }));
  expect(screen.getByText('Consultation credits remaining: 0.')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('ready');
});
it('requires main readiness for grants and labels absent credits unavailable', () => {
  render(<AetherStoreProvider><EnabledCard /></AetherStoreProvider>);
  expect((screen.getByRole('button', { name: 'Grant 3 more consultations' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Consultation credits remaining: unavailable.')).toBeTruthy();
});
it('makes one no-argument launch request and does not invent readiness on success', async () => {
  let resolve!: (result: { ok: boolean }) => void;
  const startSession = vi.fn(() => new Promise(r => { resolve = r; }));
  Object.defineProperty(window, 'aetherElectron', { value: { communication: { startSession } }, configurable: true });
  render(<AetherStoreProvider><EnabledCard /></AetherStoreProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Start fresh connected Claude' }));
  expect((screen.getByRole('button', { name: 'Starting connected Claude…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(startSession).toHaveBeenCalledTimes(1);
  expect(startSession).toHaveBeenCalledWith();
  expect(terminal.prepare.mock.invocationCallOrder.at(-1)).toBeLessThan(startSession.mock.invocationCallOrder[0]);
  await act(async () => resolve({ ok: true }));
  expect(screen.getByRole('status').textContent).toContain('waiting');
  expect(screen.getByText('mcp__aether-bridge__ask_codex')).toBeTruthy();
  expect(screen.getByText(/client-wide/)).toBeTruthy();
});
it('shows launch failure without a successful-looking status', async () => {
  const startSession = vi.fn().mockResolvedValue({ ok: false, code: 'CLEANUP_FAILED' });
  Object.defineProperty(window, 'aetherElectron', { value: { communication: { startSession } }, configurable: true });
  render(<AetherStoreProvider><EnabledCard /></AetherStoreProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Start fresh connected Claude' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cleanup failed'));
  expect(screen.getByRole('status').textContent).toContain('waiting');
});
