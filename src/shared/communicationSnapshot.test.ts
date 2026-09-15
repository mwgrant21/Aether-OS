import { afterEach, describe, expect, it } from 'vitest';
import { projectCommunicationSnapshot } from './communicationSnapshot';
import { reducer } from '../state/reducer';
import { initialState } from '../state/initialState';
import { loadPersisted, savePersisted } from '../state/persistence';
const row = () => ({ launchId: 'launch', exchangeId: 'exchange', providerState: 'streaming', failure: null,
  cleanup: 'confirmed', acceptedAt: 1, deadlineAt: 300001, leaseExpiresAt: 90001,
  finishedAt: null, contentExpiresAt: null, observedOutputBytes: null, lastOutputAt: null,
  usage: { inputTokens: null, outputTokens: 0 },
  delivery: { availability: 'pending', uniquePagesServed: 0, totalPages: null, clientConnected: true } });
const snapshot = () => ({ enabled: true, readiness: 'ready', cleanup: 'confirmed', remainingCredits: 0, sessionStatus: { instanceLabel: 'Instance 0123456789abcdef', sessionLabel: 'Session 1', prompt: 'unknown', client: 'running', connected: true }, metadata: [row()] });
afterEach(() => localStorage.clear());
describe('content-free communication state', () => {
  it('removes unexpected properties at every boundary without inventing unavailable measurements', () => {
    const raw = snapshot(), sentinel = 'PRIVATE_SENTINEL';
    Object.assign(raw, { capability: sentinel });
    Object.assign(raw.sessionStatus, { endpoint: sentinel, capability: sentinel, launchId: sentinel, rawText: sentinel });
    Object.assign(raw.metadata[0], { question: sentinel, context: sentinel, answer: sentinel, requestKeys: [sentinel] });
    Object.assign(raw.metadata[0].usage, { text: sentinel });
    Object.assign(raw.metadata[0].delivery, { payload: sentinel });
    const state = reducer(initialState, { type: 'SET_COMMUNICATION_SNAPSHOT', snapshot: raw as never });
    expect(JSON.stringify(state.communicationSnapshot)).not.toContain(sentinel);
    expect(state.communicationSnapshot).toEqual(snapshot());
    expect(state.communicationSnapshot?.remainingCredits).toBe(0);
    raw.metadata[0].delivery.uniquePagesServed = 1;
    raw.sessionStatus.sessionLabel = 'Session 2';
    expect(state.communicationSnapshot?.sessionStatus.sessionLabel).toBe('Session 1');
    expect(state.communicationSnapshot?.metadata[0].delivery.uniquePagesServed).toBe(0);
  });
  it('reports malformed or oversized metadata as unavailable rather than idle', () => {
    expect(projectCommunicationSnapshot({ ...snapshot(), readiness: 'secret' })).toBeNull();
    for (const patch of [{ providerState: 'secret' }, { observedOutputBytes: -1 }, { deadlineAt: Infinity },
      { usage: { inputTokens: 'secret', outputTokens: 0 } }, { exchangeId: '../path' },
      { delivery: { availability: 'ready', uniquePagesServed: 2, totalPages: 1, clientConnected: true } }]) {
      expect(projectCommunicationSnapshot({ ...snapshot(), metadata: [{ ...row(), ...patch }] })).toBeNull();
    }
    expect(projectCommunicationSnapshot({ ...snapshot(), metadata: Array.from({ length: 25 }, (_, i) => ({ ...row(), exchangeId: `id-${i}` })) })).toBeNull();
    expect(projectCommunicationSnapshot({ ...snapshot(), metadata: [row(), row()] })).toBeNull();
  });
  it('never navigates on updates and only selects on explicit operator action', () => {
    const updated = reducer(initialState, { type: 'SET_COMMUNICATION_SNAPSHOT', snapshot: snapshot() as never });
    expect(updated.activeTab).toBe(initialState.activeTab);
    expect(updated.selectedCommunicationExchangeId).toBeNull();
    const opened = reducer(updated, { type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: 'exchange' });
    expect(opened.activeTab).toBe('Comms'); expect(opened.selectedCommunicationExchangeId).toBe('exchange');
    const expired = reducer(opened, { type: 'SET_COMMUNICATION_SNAPSHOT', snapshot: { ...snapshot(), metadata: [] } as never });
    expect(expired.selectedCommunicationExchangeId).toBe('exchange'); // U8 can explain expired content.
    expect(reducer(initialState, { type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: 'invalid path' })).toBe(initialState);
  });
  it('excludes runtime state and selection on save and malicious rehydration', () => {
    savePersisted({ ...initialState, communicationSnapshot: snapshot() as never, selectedCommunicationExchangeId: 'exchange', communicationError: 'SECRET' });
    const persisted = JSON.parse(localStorage.getItem('aetheros-v1')!);
    for (const key of ['communicationSnapshot', 'selectedCommunicationExchangeId', 'communicationError']) expect(persisted).not.toHaveProperty(key);
    localStorage.setItem('aetheros-v1', JSON.stringify({ communicationSnapshot: snapshot(), selectedCommunicationExchangeId: 'SECRET', communicationError: 'SECRET', communicationCfg: { enabled: true } }));
    expect(loadPersisted()).toEqual({ communicationCfg: { enabled: true } });
    expect(reducer(initialState, { type: 'SET_COMMUNICATION_ERROR', error: 'SECRET' }).communicationError).not.toContain('SECRET');
  });
});

describe('session status serialization', () => {
  it('rejects missing, arbitrary, or contradictory status instead of inventing readiness', () => {
    for (const sessionStatus of [undefined, null, {},
      { ...snapshot().sessionStatus, instanceLabel: 'C:/private/path' },
      { ...snapshot().sessionStatus, sessionLabel: 'private-launch-id' },
      { ...snapshot().sessionStatus, sessionLabel: 'Session 9007199254740992' },
      { ...snapshot().sessionStatus, prompt: 'input-ready' },
      { ...snapshot().sessionStatus, prompt: 'raw terminal output' },
      { ...snapshot().sessionStatus, client: 'raw terminal output' },
      { ...snapshot().sessionStatus, connected: 'yes' },
      { ...snapshot().sessionStatus, connected: false, prompt: 'folder-trust' },
      { ...snapshot().sessionStatus, sessionLabel: null, prompt: 'folder-trust' }]) {
      expect(projectCommunicationSnapshot({ ...snapshot(), sessionStatus })).toBeNull();
    }
  });
  it('preserves independently observed prompt state even when the bridge is ready', () => {
    for (const prompt of ['unknown', 'folder-trust']) {
      expect(projectCommunicationSnapshot({ ...snapshot(), sessionStatus: { ...snapshot().sessionStatus, prompt } }))
        .toMatchObject({ readiness: 'ready', sessionStatus: { prompt } });
    }
  });
});
