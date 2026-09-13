import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeView } from './ExchangeView';
import { useExchangeSource } from './useExchangeSource';
import { initialState } from '../../state/initialState';
import { reducer } from '../../state/reducer';
import { loadPersisted, savePersisted } from '../../state/persistence';
import { deriveCommunicationIndicator } from '../layout/CommunicationIndicator';
import type { CommunicationMetadata } from '../../shared/communicationTypes';
const store = { state: initialState, dispatch: vi.fn() };
vi.mock('../../state/store', () => ({ useAetherStore: () => store }));
const row = (patch: Partial<CommunicationMetadata> = {}): CommunicationMetadata => ({ launchId: 'launch', exchangeId: 'one', providerState: 'finished', failure: null, cleanup: 'confirmed', acceptedAt: 1000, deadlineAt: 301000, leaseExpiresAt: 91000, finishedAt: 2000, contentExpiresAt: 602000, observedOutputBytes: 4, lastOutputAt: 2000, usage: null, delivery: { availability: 'ready', uniquePagesServed: 0, totalPages: 2, clientConnected: true }, ...patch });
const content = { question: 'PRIVATE_QUESTION', context: '<script>PRIVATE_CONTEXT</script>', answer: '<img src=x onerror=alert(1)>PRIVATE_ANSWER' };
let read: ReturnType<typeof vi.fn>, cancel: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn>;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(3000); localStorage.clear();
  read = vi.fn().mockResolvedValue(content); cancel = vi.fn().mockResolvedValue(undefined); copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  (window as any).aetherElectron = { communication: { readPayload: read, cancel } };
  store.state = { ...initialState, selectedCommunicationExchangeId: 'one', communicationSnapshot: { enabled: true, readiness: 'ready', cleanup: 'confirmed', sessionStatus: { instanceLabel: 'Instance 0123456789abcdef', sessionLabel: null, prompt: 'unknown' }, metadata: [row()] } }; store.dispatch.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); });
describe('mounted exchange content', () => {
  it('loads a completed answer before mount as text, copies only on click, never persists it', async () => {
    const view = render(<ExchangeView />); await flush();
    expect(screen.getByText(content.context)).toBeTruthy(); expect(screen.getByText(content.answer)).toBeTruthy();
    expect(view.container.querySelector('script,img')).toBeNull(); expect(copy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Copy answer')); await flush(); expect(copy).toHaveBeenCalledWith(content.answer);
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'VIEW_COMMUNICATION_ANSWER', exchangeId: 'one' });
    let state = reducer(store.state, { type: 'VIEW_COMMUNICATION_ANSWER', exchangeId: 'one' });
    savePersisted(state);
    expect(JSON.stringify(state)).not.toContain('PRIVATE_'); expect(localStorage.getItem('aetheros-v1')).not.toContain('PRIVATE_');
    expect(localStorage.getItem('aetheros-v1')).not.toContain('viewedCommunicationAnswers');
    expect(state.communicationSnapshot!.metadata[0].delivery.uniquePagesServed).toBe(0);
    expect(deriveCommunicationIndicator(state.communicationSnapshot, state.viewedCommunicationAnswers).readyCount).toBe(0);
    expect(screen.getByText(/replacement launch cannot retrieve/).textContent).toContain('exchange_id: one');
    expect(screen.getByText(/replacement launch cannot retrieve/).textContent).toContain('no additional consultation credit');
  });
  it('keeps full output independent of page progress and client loss', async () => {
    const view = render(<ExchangeView />); await flush();
    const metadata = row({ delivery: { availability: 'ready', uniquePagesServed: 1, totalPages: 2, clientConnected: false } });
    store.state = { ...store.state, communicationSnapshot: { ...store.state.communicationSnapshot!, metadata: [metadata] } }; view.rerender(<ExchangeView />);
    expect(screen.getByText(content.answer)).toBeTruthy(); expect(screen.getByText(/Client disconnected/)).toBeTruthy();
    expect(screen.getByText(/Missing page retrieval does not establish/)).toBeTruthy();
  });
  it('cancels only explicitly, shows partial output and clears missing selection content', async () => {
    store.state.communicationSnapshot = { ...store.state.communicationSnapshot!, metadata: [row({ providerState: 'streaming', finishedAt: null, contentExpiresAt: null })] };
    const view = render(<ExchangeView />); await flush(); expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel exchange')); await flush(); expect(cancel).toHaveBeenCalledWith('one');
    store.state = { ...store.state, communicationSnapshot: { ...store.state.communicationSnapshot!, metadata: [row({ providerState: 'failed', failure: 'PROVIDER_FAILED' })] } }; view.rerender(<ExchangeView />);
    expect(screen.getByText(/not a completed answer/)).toBeTruthy();
    store.state = { ...store.state, communicationSnapshot: { ...store.state.communicationSnapshot!, metadata: [] } }; view.rerender(<ExchangeView />);
    expect(screen.queryByText(content.answer)).toBeNull(); expect(screen.getByText(/Content unavailable or expired/)).toBeTruthy();
  });
  it('rejects hydration of operator seen state and never confuses receipt with unread', () => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ viewedCommunicationAnswers: ['one'] }));
    expect(loadPersisted()).not.toHaveProperty('viewedCommunicationAnswers');
    const snapshot = { ...store.state.communicationSnapshot!, metadata: [row({ delivery: { availability: 'ready', uniquePagesServed: 2, totalPages: 2, clientConnected: true } })] };
    expect(deriveCommunicationIndicator(snapshot, []).readyCount).toBe(1);
  });
});
describe('bounded source lifecycle', () => {
  it('serializes rapid selections and ignores stale completion', async () => {
    let release!: (v: typeof content) => void;
    read.mockImplementationOnce(() => new Promise(resolve => release = resolve));
    const hook = renderHook(({ metadata }) => useExchangeSource(metadata), { initialProps: { metadata: row() } }); await flush();
    hook.rerender({ metadata: row({ exchangeId: 'two' }) }); hook.rerender({ metadata: row({ exchangeId: 'three' }) }); await flush();
    expect(read).toHaveBeenCalledTimes(1); expect(hook.result.current.payload).toBeNull();
    await act(async () => release({ ...content, answer: 'STALE' })); await flush();
    expect(read.mock.calls.map(c => c[0])).toEqual(['one', 'three']); expect(hook.result.current.payload?.answer).toBe(content.answer);
  });
  it('keeps polling to obtain the final output after readiness changes', async () => {
    read.mockResolvedValueOnce({ ...content, answer: 'PARTIAL' });
    const hook = renderHook(({ metadata }) => useExchangeSource(metadata), { initialProps: { metadata: row({ providerState: 'streaming', contentExpiresAt: null }) } }); await flush();
    expect(hook.result.current.payload?.answer).toBe('PARTIAL');
    hook.rerender({ metadata: row() }); await flush();
    expect(hook.result.current.payload?.answer).toBe(content.answer);
    hook.rerender({ metadata: row({ launchId: 'replacement' }) });
    expect(hook.result.current.payload).toBeNull(); await flush();
  });
  it('expires at ten minutes, clears content, and does not restart polling', async () => {
    const hook = renderHook(() => useExchangeSource(row())); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(599000));
    expect(hook.result.current.payload).toBeNull(); expect(hook.result.current.status).toBe('missing');
    const count = read.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(read).toHaveBeenCalledTimes(count);
  });
  it('does not expose a late response after expiry or start another read after unmount', async () => {
    let release!: (v: typeof content) => void;
    read.mockImplementation(() => new Promise(resolve => release = resolve));
    const hook = renderHook(() => useExchangeSource(row({ contentExpiresAt: 3100 }))); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(100)); await act(async () => release(content));
    expect(hook.result.current.payload).toBeNull(); hook.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(read).toHaveBeenCalledTimes(1);
  });
  it('unmount stops polling and invalid payloads/errors do not leak content', async () => {
    read.mockRejectedValueOnce(new Error('PRIVATE_ERROR')).mockResolvedValueOnce({ ...content, answer: 'x'.repeat(65537) });
    const hook = renderHook(() => useExchangeSource(row())); await flush(); expect(hook.result.current.status).toBe('error');
    await act(async () => vi.advanceTimersByTimeAsync(500)); expect(hook.result.current.status).toBe('error'); expect(hook.result.current.payload).toBeNull();
    hook.unmount(); await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(read).toHaveBeenCalledTimes(2);
  });
});
