import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from './store';
import { useCommunicationSync } from './useCommunicationSync';
import { initialState } from './initialState';
import { loadPersisted, savePersisted } from './persistence';
import type { CommunicationBridgeSnapshot } from '../../electron/communicationBridge/mainIntegration';
const disabled: CommunicationBridgeSnapshot = { enabled: false, readiness: 'disabled', cleanup: 'confirmed', sessionStatus: { instanceLabel: 'Instance 0123456789abcdef', sessionLabel: null, prompt: 'unknown' }, metadata: [] };
const ready: CommunicationBridgeSnapshot = { ...disabled, enabled: true, readiness: 'ready' };
function Harness() {
  useCommunicationSync();
  const { state, dispatch } = useAetherStore();
  return <><output>{JSON.stringify({ snapshot: state.communicationSnapshot, error: state.communicationError })}</output>
    <button onClick={() => dispatch({ type: 'SET_COMMUNICATION_CFG', enabled: !state.communicationCfg.enabled })}>toggle</button></>;
}
function setup() {
  let listener: (snapshot: CommunicationBridgeSnapshot) => void = () => {};
  const unsubscribe = vi.fn();
  const api = { snapshot: vi.fn().mockResolvedValue(disabled), setEnabled: vi.fn().mockResolvedValue({ ok: true }),
    onSnapshot: vi.fn(callback => { listener = callback; return unsubscribe; }),
    launch: vi.fn(), grant: vi.fn() };
  Object.defineProperty(window, 'aetherElectron', { value: { communication: api }, configurable: true });
  return { api, unsubscribe, push: (value: CommunicationBridgeSnapshot) => act(() => listener(value)) };
}
afterEach(() => { cleanup(); localStorage.clear(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });
describe('communication bootstrap', () => {
  it('restores enabled preference without Settings or launching or granting', async () => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ communicationCfg: { enabled: true } }));
    const { api, unsubscribe } = setup();
    const view = render(<AetherStoreProvider><Harness /></AetherStoreProvider>);
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true));
    expect(api.launch).not.toHaveBeenCalled(); expect(api.grant).not.toHaveBeenCalled();
    view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('does not overwrite a pushed snapshot with late query results', async () => {
    const { api, push } = setup();
    let resolve!: (snapshot: CommunicationBridgeSnapshot) => void;
    api.snapshot.mockImplementation(() => new Promise(r => { resolve = r; }));
    render(<AetherStoreProvider><Harness /></AetherStoreProvider>);
    await waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
    push(ready);
    await act(async () => resolve(disabled));
    expect(screen.getByRole('status').textContent).toContain('ready');
  });
  it('shows failed preference results and syncs subsequent toggles', async () => {
    const { api } = setup();
    api.setEnabled.mockResolvedValue({ ok: false, code: 'SHUTTING_DOWN' });
    render(<AetherStoreProvider><Harness /></AetherStoreProvider>);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('SHUTTING_DOWN'));
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith(true));
    await waitFor(() => expect(api.setEnabled).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole('status').textContent).toContain('SHUTTING_DOWN');
    api.setEnabled.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByText('toggle'));
    await waitFor(() => expect(api.setEnabled).toHaveBeenLastCalledWith(true));
  });
  it.each([null, 'true', 1, {}, { enabled: 'true' }, { enabled: 1 }])('rejects malformed preference %j', value => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ communicationCfg: value, communicationSnapshot: ready, communicationError: 'stale' }));
    expect(loadPersisted()?.communicationCfg).toEqual({ enabled: false });
    expect(loadPersisted()?.communicationSnapshot).toBeUndefined();
    expect(loadPersisted()?.communicationError).toBeUndefined();
  });
  it('persists only the enabled preference, never runtime data', () => {
    savePersisted({ ...initialState, communicationCfg: { enabled: true }, communicationSnapshot: ready, communicationError: 'stale' });
    const raw = JSON.parse(localStorage.getItem('aetheros-v1')!);
    expect(raw.communicationCfg).toEqual({ enabled: true });
    expect(raw.communicationSnapshot).toBeUndefined(); expect(raw.communicationError).toBeUndefined();
  });
});
