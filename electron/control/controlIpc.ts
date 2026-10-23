// electron/control/controlIpc.ts
//
// Trusted IPC for the Settings PHONE CONTROL block, mirroring electron/remote/remoteIpc.ts. Every channel checks the
// sender, validates its arguments, and only then touches the hub. Turning control on, and turning the launch
// re-enable on, each pass through a native confirm that main supplies; a declined confirm returns the current status
// without calling the hub. Status carries no secret; only createPairing returns a code.
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { ControlPairingResult, ControlStatus } from '../../src/shared/remote/types';

/** The slice of the hub the renderer may drive. */
export interface ControlHubLike {
  init(): void;
  status(): ControlStatus;
  setEnabled(on: boolean): Promise<ControlStatus>;
  setReenableAtLaunch(on: boolean): Promise<ControlStatus>;
  createPairing(): Promise<ControlPairingResult>;
  revokeAll(): Promise<ControlStatus>;
  revokeOne(ref: string): Promise<ControlStatus>;
}

const REF_RE = /^[0-9a-f]{12}$/;

export function registerControlIpc(
  ipc: Pick<IpcMain, 'handle'>,
  hub: ControlHubLike,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  confirmEnable: () => Promise<boolean>,
  confirmReenable: () => Promise<boolean>,
): void {
  const handle = (name: string, valid: (args: unknown[]) => boolean, run: (...args: unknown[]) => unknown) => {
    ipc.handle(`control:${name}`, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('NOT_AUTHORIZED');
      if (!valid(args)) throw new Error('INVALID_INPUT');
      hub.init();
      return run(...args);
    });
  };
  const none = (args: unknown[]) => args.length === 0;
  const oneBool = (args: unknown[]) => args.length === 1 && typeof args[0] === 'boolean';
  handle('status', none, () => hub.status());
  handle('setEnabled', oneBool, async value => {
    if (value === true && !(await confirmEnable())) return hub.status();
    return hub.setEnabled(value as boolean);
  });
  handle('setReenableAtLaunch', oneBool, async value => {
    if (value === true && !(await confirmReenable())) return hub.status();
    return hub.setReenableAtLaunch(value as boolean);
  });
  handle('createPairing', none, () => hub.createPairing());
  handle('revokeAll', none, () => hub.revokeAll());
  handle('revokeOne', args => args.length === 1 && typeof args[0] === 'string' && REF_RE.test(args[0]), ref => hub.revokeOne(ref as string));
}
