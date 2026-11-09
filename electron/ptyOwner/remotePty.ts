// Main-side PtyLike for a shell owned by the detached pty-owner helper. Created by ownerClient;
// the client feeds it inbound frames. Inbound data/exit are BUFFERED until resume() so the
// adoption sequence (register callbacks, onAlive, then replay) never sees output early, and
// nothing is lost or reordered when output exists before onData is registered.
// write/resize/kill never throw: a dead connection drops the call and marks the shell exited.
import type { PtyLike } from '../ptyLifecycle';
import type { ClientFrame } from './protocol';
import type { TerminalSlotId } from '../../src/shared/remote/types';

/** What a RemotePty needs from its connection. */
export interface RemoteLink {
  /** True when the frame was written. Never throws. */
  send(frame: ClientFrame): boolean;
  /** True once the connection is gone for good (not merely reconnecting). */
  dead(): boolean;
}

export class RemotePty implements PtyLike {
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: (() => void) | null = null;
  private queue: string[] = [];
  private have = 0; // highest seq accepted; a fresh instance per spawn, so a restarted seq never collides
  private resumed = false;
  private exitSeen = false;
  private exitFired = false;
  private pumping = false;

  constructor(readonly slot: TerminalSlotId, private readonly link: RemoteLink) {}

  onData(callback: (data: string) => void): void { this.dataCb = callback; this.pump(); }
  onExit(callback: () => void): void { this.exitCb = callback; this.pump(); }

  write(input: string): void { this.sendOrGone({ t: 'write', slot: this.slot, d: input }); }
  resize(cols: number, rows: number): void { this.sendOrGone({ t: 'resize', slot: this.slot, cols, rows }); }
  kill(): void { this.sendOrGone({ t: 'kill', slot: this.slot }); }

  /** Start delivering: buffered ring entries and live frames in seq order, then streaming. */
  resume(): void { this.resumed = true; this.pump(); }

  /** True once the shell is known to be over (exit seen, or connection lost). */
  get finished(): boolean { return this.exitSeen; }

  // ---- fed by ownerClient ----
  deliver(seq: number, d: string): void {
    if (this.exitSeen || seq <= this.have) return; // duplicate (reconnect replay) or after exit
    this.have = seq;
    this.queue.push(d);
    this.pump();
  }
  /** Advance the dedupe floor without delivering (ring chunks the helper dropped from its ring). */
  bump(seq: number): void { if (seq > this.have) this.have = seq; }
  deliverExit(): void { if (this.exitSeen) return; this.exitSeen = true; this.pump(); }

  private sendOrGone(frame: ClientFrame): void {
    let ok = false;
    try { ok = this.link.send(frame); } catch { ok = false; }
    if (!ok && this.link.dead()) this.deliverExit();
  }

  private pump(): void {
    if (!this.resumed || this.pumping) return;
    this.pumping = true;
    try {
      while (this.dataCb && this.queue.length > 0) {
        const d = this.queue.shift()!;
        try { this.dataCb(d); } catch { /* a consumer fault must not wedge the stream */ }
      }
      if (this.exitSeen && !this.exitFired && this.exitCb && this.queue.length === 0) {
        this.exitFired = true;
        try { this.exitCb(); } catch { /* ignore */ }
      }
    } finally { this.pumping = false; }
  }
}
