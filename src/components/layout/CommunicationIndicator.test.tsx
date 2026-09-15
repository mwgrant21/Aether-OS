import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CommunicationIndicator, deriveCommunicationIndicator } from './CommunicationIndicator';
import type { CommunicationMetadata } from '../../shared/communicationTypes';
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import { initialState } from '../../state/initialState';
const store = vi.hoisted(() => ({ state: {} as typeof initialState, dispatch: vi.fn() }));
vi.mock('../../state/store', () => ({ useAetherStore: () => store }));
function row(patch: Partial<CommunicationMetadata> = {}): CommunicationMetadata {
  return { exchangeId: 'one', launchId: 'launch', providerState: 'waiting', failure: null,
    cleanup: 'confirmed', acceptedAt: 1, deadlineAt: 300001, leaseExpiresAt: 90001,
    finishedAt: null, contentExpiresAt: null, observedOutputBytes: null, lastOutputAt: null,
    usage: null, delivery: { availability: 'pending', uniquePagesServed: 0, totalPages: null, clientConnected: true }, ...patch };
}
const snapshot = (metadata: CommunicationMetadata[]): CommunicationBridgeSnapshot => ({ enabled: true, readiness: 'ready', cleanup: 'confirmed', sessionStatus: { instanceLabel: 'Instance 0123456789abcdef', sessionLabel: 'Session 1', prompt: 'unknown', client: 'running', connected: true }, metadata });
afterEach(() => { cleanup(); store.dispatch.mockClear(); });
describe('communication metadata indicator', () => {
  it('chooses active first, then newest retained without mutating metadata', () => {
    const retained = row({ exchangeId: 'new', acceptedAt: 20, providerState: 'finished' });
    const running = row();
    const input = snapshot([retained, running]);
    expect(deriveCommunicationIndicator(input).exchangeId).toBe('one');
    expect(input.metadata[0]).toBe(retained);
    expect(deriveCommunicationIndicator(snapshot([row({ providerState: 'finished' }), retained])).exchangeId).toBe('new');
  });
  it.each(['accepted', 'preparing', 'waiting', 'cancelling'] as const)('shows request direction for %s without answer claims', providerState => {
    const view = deriveCommunicationIndicator(snapshot([row({ providerState })]));
    expect(view.heading).toBe('Claude → Codex');
    expect(view.delivery).toBe('Answer pending');
  });
  it('separates streaming from answer ready and all/some actual pages served', () => {
    expect(deriveCommunicationIndicator(snapshot([row({ providerState: 'streaming' })])).heading).toBe('Codex → Aether');
    const ready = row({ providerState: 'finished', delivery: { availability: 'ready', uniquePagesServed: 0, totalPages: 2, clientConnected: true } });
    const view = deriveCommunicationIndicator(snapshot([ready]));
    expect(view).toMatchObject({ heading: 'Codex → Aether', delivery: 'Answer ready · no pages served', readyCount: 1 });
    expect(deriveCommunicationIndicator(snapshot([{ ...ready, delivery: { ...ready.delivery, uniquePagesServed: 1 } }]))).toMatchObject({ heading: 'Aether → Claude', delivery: '1 of 2 pages served', readyCount: 1 });
    expect(deriveCommunicationIndicator(snapshot([{ ...ready, delivery: { ...ready.delivery, uniquePagesServed: 2 } }])).delivery).toBe('All 2 pages served');
  });
  it.each(['cancelled', 'timed-out', 'failed'] as const)('retains %s, disconnection, and failed cleanup', providerState => {
    const view = deriveCommunicationIndicator(snapshot([row({ providerState, cleanup: 'failed', delivery: { availability: 'unavailable', uniquePagesServed: 0, totalPages: null, clientConnected: false } })]));
    expect(view.health).toBe('Client disconnected · Cleanup failed');
    expect(view.delivery).toBe('Answer unavailable');
  });
  it('keeps unavailable, disabled, and idle states distinct', () => {
    expect(deriveCommunicationIndicator(null).detail).toBe('Status unavailable');
    expect(deriveCommunicationIndicator({ ...snapshot([]), enabled: false, readiness: 'disabled', cleanup: 'pending' })).toMatchObject({ detail: 'Bridge disabled', health: 'Cleanup pending' });
    expect(deriveCommunicationIndicator(snapshot([]))).toMatchObject({ exchangeId: null, detail: 'Bridge ready' });
  });
  it('renders a static focusable native button and navigates only upon activation', () => {
    store.state = { ...initialState, communicationSnapshot: snapshot([row()]) };
    const view = render(<CommunicationIndicator />);
    const button = screen.getByRole('button', { name: /Open communication/ });
    expect(store.dispatch).not.toHaveBeenCalled();
    button.focus(); expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe('BUTTON'); expect(button.tabIndex).toBe(0);
    expect(button.className).not.toContain('anim'); expect(button.style.animation).toBe('');
    fireEvent.click(button, { detail: 0 }); // Native keyboard activation dispatches a click with detail=0.
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: 'one' });
    store.dispatch.mockClear();
    store.state = { ...initialState, communicationSnapshot: snapshot([]) };
    view.rerender(<CommunicationIndicator />);
    expect(store.dispatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: null });
  });
});
