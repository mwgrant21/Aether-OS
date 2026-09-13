import { describe, expect, it, vi } from 'vitest';
import { registerCommunicationIpc } from './ipc';

function setup() {
  const handlers = new Map<string, Function>();
  const service = { snapshot: vi.fn(() => ({ enabled: false })), setEnabled: vi.fn(), readPayload: vi.fn(), cancel: vi.fn(), clear: vi.fn() };
  registerCommunicationIpc({ handle: (name: string, callback: Function) => { handlers.set(name, callback); } } as never, service as never, event => event === trusted);
  return { service, call: (name: string, event: unknown, ...args: unknown[]) => handlers.get(`communication:${name}`)!(event, ...args), handlers };
}
const trusted = {} as never;
describe('communication IPC', () => {
  it('validates operator requests before presenting native confirmations', () => {
    const handlers = new Map<string, Function>();
    const operator = { startSession: vi.fn(), grantMore: vi.fn() };
    registerCommunicationIpc({ handle: (name: string, fn: Function) => { handlers.set(name, fn); } } as never, {} as never,
      event => event === trusted, operator);
    const start = handlers.get('communication:startSession')!, grant = handlers.get('communication:grantMore')!;
    expect(() => start({}, 'bad')).toThrow('NOT_AUTHORIZED');
    expect(() => start(trusted, {})).toThrow('INVALID_INPUT');
    expect(() => grant(trusted, { launchId: 'forged' })).toThrow('INVALID_INPUT');
    expect(() => grant(trusted, 'valid', 'extra')).toThrow('INVALID_INPUT');
    expect(operator.startSession).not.toHaveBeenCalled(); expect(operator.grantMore).not.toHaveBeenCalled();
    start(trusted); grant(trusted, 'confirm-1');
    expect(operator.grantMore).toHaveBeenCalledWith('confirm-1');
  });
  it('exposes only five bounded renderer operations', () => {
    const { handlers, call, service } = setup();
    expect([...handlers.keys()]).toEqual(['snapshot', 'setEnabled', 'readPayload', 'cancel', 'clear'].map(n => `communication:${n}`));
    expect(call('snapshot', trusted)).toEqual({ enabled: false });
    call('setEnabled', trusted, true);
    expect(service.setEnabled).toHaveBeenCalledWith(true);
    for (const name of ['readPayload', 'cancel', 'clear'] as const) {
      call(name, trusted, 'abc-123');
      expect(service[name]).toHaveBeenCalledWith('abc-123');
    }
  });
  it('rejects an untrusted sender before accessing service state', () => {
    const { call, service } = setup();
    for (const name of Object.keys(service)) expect(() => call(name, {})).toThrow('NOT_AUTHORIZED');
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
  it('rejects malformed or extra arguments', () => {
    const { call, service } = setup();
    expect(() => call('snapshot', trusted, null)).toThrow('INVALID_INPUT');
    for (const value of ['true', 1, null, {}, []]) expect(() => call('setEnabled', trusted, value)).toThrow('INVALID_INPUT');
    expect(() => call('setEnabled', trusted, true, false)).toThrow('INVALID_INPUT');
    for (const name of ['readPayload', 'cancel', 'clear']) {
      for (const value of ['', '../x', 'x'.repeat(65), null, {}, 1]) expect(() => call(name, trusted, value)).toThrow('INVALID_INPUT');
      expect(() => call(name, trusted, 'valid', {})).toThrow('INVALID_INPUT');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});
