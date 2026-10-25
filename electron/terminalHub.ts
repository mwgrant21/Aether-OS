import { PtyLifecycle } from './ptyLifecycle';
import { TERMINAL_SLOTS, type TerminalSlotId } from '../src/shared/remote/types';

/** One of the three desktop terminals. Behaves exactly like PtyLifecycle. */
export class TerminalSlot extends PtyLifecycle {
  constructor(readonly id: TerminalSlotId) { super(); }
}

export interface TerminalHub {
  slot(id: TerminalSlotId): TerminalSlot;
}

/** Owns the three PtyLifecycles (claude, terminal2, codex). */
export function createTerminalHub(): TerminalHub {
  const slots = new Map<TerminalSlotId, TerminalSlot>(TERMINAL_SLOTS.map(({ s }) => [s, new TerminalSlot(s)]));
  return { slot: (id) => slots.get(id) as TerminalSlot };
}
