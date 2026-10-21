import { REMOTE_REPLAY_BYTES } from '../../src/shared/remote/types';
import type { ChatEvent } from './types';

export interface ReplayBuffer {
  push(e: ChatEvent): void;
  snapshot(): ChatEvent[];
  clear(): void;
  readonly bytes: number;
}

/** Bounded buffer of the newest chat events. Size is UTF-8 bytes of the JSON form. Memory only. */
export function createReplayBuffer(maxBytes: number = REMOTE_REPLAY_BYTES): ReplayBuffer {
  let items: { e: ChatEvent; size: number }[] = [];
  let total = 0;
  return {
    push(e) {
      const size = Buffer.byteLength(JSON.stringify(e));
      if (size > maxBytes) return;
      items.push({ e, size });
      total += size;
      while (total > maxBytes && items.length > 0) total -= items.shift()!.size;
    },
    snapshot: () => items.map((i) => i.e),
    clear() {
      items = [];
      total = 0;
    },
    get bytes() {
      return total;
    },
  };
}
