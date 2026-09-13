export class ConnectedCleanupError extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(`Connected fixture cleanup failed in ${causes.length} step${causes.length === 1 ? '' : 's'}`);
    this.name = 'ConnectedCleanupError';
  }
}

export interface ConnectedCleanupOptions {
  readonly writeDiagnostics: () => void | Promise<void>;
  readonly requestExit: () => void | Promise<void>;
  readonly closeApp: () => Promise<void>;
  readonly forceCloseApp: () => void | Promise<void>;
  readonly ownedPids: readonly number[];
  readonly isAlive: (pid: number) => boolean;
  readonly terminatePid: (pid: number) => void | Promise<void>;
  readonly waitForOwnedExit: () => Promise<void>;
  readonly closeTimeoutMs?: number;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
    return await operation;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Preserve cleanup failures while ensuring each later cleanup stage is still attempted. */
export async function cleanupConnectedProduction(options: ConnectedCleanupOptions): Promise<void> {
  const errors: unknown[] = [];
  try { await options.writeDiagnostics(); } catch (error) { errors.push(error); }
  try { await options.requestExit(); } catch (error) { errors.push(error); }

  let fallback = false;
  try { await bounded(options.closeApp(), options.closeTimeoutMs ?? 5000, 'Electron close timed out'); }
  catch (error) { errors.push(error); fallback = true; }

  if (!fallback) {
    try { await options.waitForOwnedExit(); }
    catch { fallback = true; }
  }

  if (fallback) {
    try { await options.forceCloseApp(); } catch (error) { errors.push(error); }
    for (const pid of options.ownedPids) {
      if (!options.isAlive(pid)) continue;
      try { await options.terminatePid(pid); } catch (error) { errors.push(error); }
    }
    try { await options.waitForOwnedExit(); } catch (error) { errors.push(error); }
  }

  if (errors.length) throw new ConnectedCleanupError(errors);
}

export async function guardConnectedSetup<T>(setup: () => Promise<T>, closeApp: () => Promise<void>,
  forceCloseApp: () => void | Promise<void>, setupTimeoutMs = 30000, closeTimeoutMs = 5000): Promise<T> {
  try { return await bounded(setup(), setupTimeoutMs, 'Connected fixture setup timed out'); }
  catch (setupError) {
    try {
      await cleanupConnectedProduction({ writeDiagnostics: () => {}, requestExit: () => {}, closeApp, forceCloseApp,
        ownedPids: [], isAlive: () => false, terminatePid: () => {}, waitForOwnedExit: async () => {}, closeTimeoutMs });
    } catch (cleanupError) {
      const cleanupCauses = cleanupError instanceof ConnectedCleanupError ? cleanupError.causes : [cleanupError];
      throw new ConnectedCleanupError([setupError, ...cleanupCauses]);
    }
    throw setupError;
  }
}
