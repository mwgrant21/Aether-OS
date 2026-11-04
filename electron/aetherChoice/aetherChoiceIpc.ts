import { LAUNCH_EFFORTS, MODEL_ALIASES } from '../../src/shared/aetherChoice/types';
import type { Pick } from '../../src/shared/aetherChoice/types';
import type {
  AetherChoiceClear,
  AetherChoiceSlotState,
  AetherChoiceState,
  AetherChoiceSubmit,
  AetherChoiceSubmitResult,
} from '../../src/shared/aetherChoice/ipc';

/** The slice of the runtime the renderer may drive. Nothing here writes to a port. */
export interface AetherChoiceRuntimeLike {
  state(slot: string): AetherChoiceSlotState | null;
  submitPick(slot: string, pick: Pick): { rejected: string | null };
  clearHalt(slot: string): void;
}

/** Structural stand-in for ipcMain: a type-only `electron` import would trip the boundary scan. */
export interface IpcLike<E> {
  handle(channel: string, listener: (event: E, ...args: unknown[]) => unknown): void;
}

const SLOTS: readonly string[] = ['claude', 'terminal2'];

function plainObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every(k => own.includes(k))) return null;
  return value as Record<string, unknown>;
}

function slotOf(value: unknown): 'claude' | 'terminal2' | null {
  return typeof value === 'string' && SLOTS.includes(value) ? (value as 'claude' | 'terminal2') : null;
}

export function parseSubmit(args: unknown[]): AetherChoiceSubmit | null {
  if (args.length !== 1) return null;
  const o = plainObject(args[0], ['slot', 'model', 'effort']);
  if (!o) return null;
  const slot = slotOf(o.slot);
  const model = (MODEL_ALIASES as readonly unknown[]).find(m => m === o.model);
  const effort = (LAUNCH_EFFORTS as readonly unknown[]).find(e => e === o.effort);
  if (!slot || model === undefined || effort === undefined) return null;
  return { slot, model: model as AetherChoiceSubmit['model'], effort: effort as AetherChoiceSubmit['effort'] };
}

export function parseClear(args: unknown[]): AetherChoiceClear | null {
  if (args.length !== 1) return null;
  const o = plainObject(args[0], ['slot']);
  const slot = o ? slotOf(o.slot) : null;
  return slot ? { slot } : null;
}

function safeState(runtime: AetherChoiceRuntimeLike, slot: string): AetherChoiceSlotState | null {
  try {
    return runtime.state(slot);
  } catch {
    return null;
  }
}

/** Pull/command IPC only. Fails closed: untrusted sender, then malformed input, then a fixed-enum result. */
export function registerAetherChoiceIpc<E>(
  ipc: IpcLike<E>,
  runtime: AetherChoiceRuntimeLike,
  trusted: (event: E) => boolean,
): void {
  const handle = (channel: string, run: (args: unknown[]) => unknown) => {
    ipc.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error('NOT_AUTHORIZED');
      return run(args);
    });
  };
  const invalid = (): never => {
    throw new Error('INVALID_INPUT');
  };

  handle('aetherChoice:state', (args): AetherChoiceState => {
    if (args.length !== 0) return invalid();
    return { claude: safeState(runtime, 'claude'), terminal2: safeState(runtime, 'terminal2') };
  });
  handle('aetherChoice:submit', (args): AetherChoiceSubmitResult => {
    const p = parseSubmit(args);
    if (!p) return invalid();
    try {
      return runtime.submitPick(p.slot, { model: p.model, effort: p.effort }).rejected === null ? { ok: true } : { ok: false };
    } catch {
      return { ok: false };
    }
  });
  handle('aetherChoice:clear-halt', (args): void => {
    const p = parseClear(args);
    if (!p) return invalid();
    try {
      runtime.clearHalt(p.slot);
    } catch {
      /* swallowed: the renderer re-pulls state */
    }
  });
}
