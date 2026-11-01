import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { VoicePairingResult, VoiceStatus } from '../../src/shared/voice/types';

/** The slice of the hub the renderer may drive. Status carries no secret; only createPairing returns a code. */
export interface VoiceHubLike {
  init(): void;
  status(): VoiceStatus;
  setEnabled(on: boolean): Promise<VoiceStatus>;
  createPairing(): Promise<VoicePairingResult>;
  revokeAll(): Promise<VoiceStatus>;
  revokeOne(ref: string): Promise<VoiceStatus>;
}

const REF_RE = /^[0-9a-f]{12}$/;

/** Pull/command IPC only. Enabling always passes through the native `confirmEnable` dialog supplied by main. */
export function registerVoiceIpc(
  ipc: Pick<IpcMain, 'handle'>,
  hub: VoiceHubLike,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  confirmEnable: () => Promise<boolean>,
): void {
  const handle = (name: string, valid: (args: unknown[]) => boolean, run: (...args: unknown[]) => unknown) => {
    ipc.handle(`voice:${name}`, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('NOT_AUTHORIZED');
      if (!valid(args)) throw new Error('INVALID_INPUT');
      hub.init();
      return run(...args);
    });
  };
  const none = (args: unknown[]) => args.length === 0;
  handle('status', none, () => hub.status());
  handle('setEnabled', args => args.length === 1 && typeof args[0] === 'boolean', async value => {
    if (value === true && !(await confirmEnable())) return hub.status();
    return hub.setEnabled(value as boolean);
  });
  handle('createPairing', none, () => hub.createPairing());
  handle('revokeAll', none, () => hub.revokeAll());
  handle('revokeOne', args => args.length === 1 && typeof args[0] === 'string' && REF_RE.test(args[0]), ref => hub.revokeOne(ref as string));
}
