import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { CommunicationBridgeIntegration } from './mainIntegration';

type RendererService = Pick<CommunicationBridgeIntegration, 'snapshot' | 'setEnabled' | 'readPayload' | 'cancel' | 'clear'>;
/** No renderer channel returns a capability or creates a Claude launch. */
export function registerCommunicationIpc(ipc: Pick<IpcMain, 'handle'>, service: RendererService,
  trusted: (event: IpcMainInvokeEvent) => boolean): void {
  const handle = (name: string, valid: (args: unknown[]) => boolean, run: (...args: unknown[]) => unknown) => {
    ipc.handle(`communication:${name}`, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('NOT_AUTHORIZED');
      if (!valid(args)) throw new Error('INVALID_INPUT');
      return run(...args);
    });
  };
  const id = (args: unknown[]) => args.length === 1 && typeof args[0] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(args[0]);
  handle('snapshot', args => args.length === 0, () => service.snapshot());
  handle('setEnabled', args => args.length === 1 && typeof args[0] === 'boolean', value => service.setEnabled(value as boolean));
  handle('readPayload', id, value => service.readPayload(value as string));
  handle('cancel', id, value => service.cancel(value as string));
  handle('clear', id, value => service.clear(value as string));
}
