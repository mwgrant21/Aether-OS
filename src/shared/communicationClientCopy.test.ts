import { describe, expect, it } from 'vitest';
import type { CommunicationBridgeSnapshot } from '../../electron/communicationBridge/mainIntegration';
import { communicationClientCopy } from './communicationClientCopy';

const snapshot = (status: Partial<CommunicationBridgeSnapshot['sessionStatus']> = {}, readiness: CommunicationBridgeSnapshot['readiness'] = 'waiting'): CommunicationBridgeSnapshot => ({
  enabled: true, cleanup: 'confirmed', metadata: [], readiness,
  sessionStatus: { instanceLabel: 'Instance abcdef1234567890', sessionLabel: 'Session 1', prompt: 'unknown', client: 'unknown', connected: true, ...status },
});
describe('client attention copy', () => {
  it('does not infer a problem for a never-launched or disabled bridge', () => {
    expect(communicationClientCopy(null)).toBeNull();
    expect(communicationClientCopy(snapshot({ sessionLabel: null, connected: false }))).toBeNull();
    expect(communicationClientCopy({ ...snapshot(), enabled: false })).toBeNull();
  });
  it('uses positive current prompt evidence regardless of bridge discovery', () => {
    for (const readiness of ['waiting', 'authenticated', 'ready'] as const)
      expect(communicationClientCopy(snapshot({ prompt: 'folder-trust' }, readiness))?.title).toBe('Action required: folder trust');
  });
  it('helper loss and unknown output never become exit or input readiness', () => {
    for (const client of ['unknown', 'starting', 'running'] as const)
      expect(communicationClientCopy(snapshot({ client, connected: false }, 'disconnected'))?.title).toBe('Client not ready — check terminal');
    expect(communicationClientCopy(snapshot({}, 'ready'))?.title).toBe('Client not ready — check terminal');
  });
  it('only positive lifecycle evidence supplies exit/failure copy, overriding stale prompt', () => {
    expect(communicationClientCopy(snapshot({ client: 'exited', prompt: 'folder-trust', connected: false }, 'disconnected'))?.title).toBe('Client exited');
    expect(communicationClientCopy(snapshot({ client: 'failed', connected: false }, 'disconnected'))?.title).toBe('Client launch failed');
  });
  it('clears actionable copy across prompt uncertainty, disconnect, exit and replacement', () => {
    const sequence = [snapshot({ prompt: 'folder-trust' }), snapshot(), snapshot({ connected: false }, 'disconnected'),
      snapshot({ client: 'exited', connected: false }, 'disconnected'), snapshot({ sessionLabel: 'Session 2', client: 'starting' })];
    expect(sequence.map(s => communicationClientCopy(s)?.title)).toEqual(['Action required: folder trust',
      'Client not ready — check terminal', 'Client not ready — check terminal', 'Client exited', 'Client not ready — check terminal']);
    expect(sequence.map(s => communicationClientCopy(s)?.detail).join(' ')).not.toMatch(/press Enter|default choice/i);
  });
});
