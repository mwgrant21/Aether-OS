/** Minimal structural view of a node-pty session -- only what the lifecycle
 *  below touches. Keeps this module (and its tests) free of node-pty itself,
 *  which is a native module that cannot be loaded in the test environment. */
export interface PtyLike {
  onData(callback: (data: string) => void): void;
  onExit(callback: () => void): void;
  kill(): void;
  write(input: string): void;
  resize(cols: number, rows: number): void;
}

export interface PtyLifecycleHandlers {
  onData: (data: string) => void;
  /** Fired once, synchronously, after a pty is spawned and wired. */
  onAlive: () => void;
  /** Fired only when the CURRENT pty exits. */
  onExit: () => void;
}

/** Owns the single active pty and the "is this still the live one?" rule.
 *
 *  The rule exists because `onExit` fires asynchronously. When `start()` is
 *  called a second time (a renderer reload, or any future respawn flow) the
 *  previous pty is killed and replaced; by the time the OLD pty's exit
 *  callback actually runs, the active pty is already the NEW one. Broadcasting
 *  that exit would report the terminal as dead while a perfectly healthy
 *  session is running, and nothing would ever correct it back. So each exit
 *  callback closes over the exact instance it was registered for and stays
 *  silent unless that instance is still the active one. */
export class PtyLifecycle {
  private active: PtyLike | null = null;

  get current(): PtyLike | null {
    return this.active;
  }

  start(spawn: () => PtyLike, handlers: PtyLifecycleHandlers): PtyLike {
    if (this.active) {
      this.active.kill();
      this.active = null;
    }
    const pty = spawn();
    this.active = pty;
    pty.onData((data) => handlers.onData(data));
    pty.onExit(() => {
      if (this.active !== pty) return; // superseded -- not the live session's exit
      handlers.onExit();
    });
    handlers.onAlive();
    return pty;
  }

  write(input: string): void {
    this.active?.write(input);
  }

  resize(cols: number, rows: number): void {
    this.active?.resize(cols, rows);
  }
}
