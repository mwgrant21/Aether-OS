import type { CommunicationBridgeIntegration, CommunicationLaunchManifest } from './mainIntegration';

export type SessionResult = { ok: true } | { ok: false; code: string };
export interface LaunchBundle {
  completion(): Promise<'unknown' | 'starting' | 'running' | 'exited' | 'failed'>;
  cleanup(): Promise<void>;
}
/** Serializes operator intent. No renderer-supplied command or credential enters this API. */
export class CommunicationSessionControl<T extends LaunchBundle> {
  private pending = false;
  constructor(private readonly options: {
    bridge: CommunicationBridgeIntegration;
    confirm(): Promise<boolean>;
    preflight?(): Promise<void>;
    prepare(manifest: CommunicationLaunchManifest): Promise<T>;
    spawn(bundle: T, onExit: () => void): void;
    pollMs?: number;
    statusReadMs?: number;
  }) {}
  get busy(): boolean { return this.pending; }
  async start(): Promise<SessionResult> {
    if (this.pending) return { ok: false, code: 'BUSY' };
    this.pending = true;
    const bridge = this.options.bridge;
    let launchId: string | undefined;
    try {
      if (!bridge.snapshot().enabled) return { ok: false, code: 'DISABLED' };
      if (!await this.options.confirm()) return { ok: false, code: 'CANCELLED' };
      await this.options.preflight?.();
      if (!bridge.snapshot().enabled) return { ok: false, code: 'DISABLED' };
      const manifest = await bridge.prepareLaunch(); launchId = manifest.launchId;
      let timer: ReturnType<typeof setInterval> | undefined;
      let reading: Promise<void> | undefined;
      const id = launchId;
      const sample = (bundle: T): Promise<void> => {
        if (reading) return reading;
        if (!bridge.isDisplayedLaunch(id)) { clearInterval(timer); return Promise.resolve(); }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const read = Promise.race([
          Promise.resolve().then(() => bundle.completion()),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('LAUNCH_STATUS_UNREADABLE')), this.options.statusReadMs ?? 1000);
          }),
        ]);
        reading = read.then(state => {
          if (!bridge.observeClient(id, state) || state === 'exited' || state === 'failed'
            || (state === 'unknown' && bridge.currentLaunchId() !== id)) clearInterval(timer);
        }, () => {
          // An unreadable observation is not a failed client or positive exit.
          // Revoke first so prompt evidence is cleared before any publication.
          void bridge.notifyClaudeExit(id);
          bridge.observeClient(id, 'unknown'); clearInterval(timer);
        }).finally(() => { clearTimeout(deadline); reading = undefined; });
        return reading;
      };
      // Reserve cleanup BEFORE starting asynchronous file creation. Disable owns
      // this same operation even if the resource appears after revocation.
      let finish!: (resource: { bundle?: T; cleanupFailed?: boolean }) => void;
      const created = new Promise<{ bundle?: T; cleanupFailed?: boolean }>(resolve => { finish = resolve; });
      bridge.attachLaunchCleanup(launchId, async () => {
        const resource = await created;
        if (resource.cleanupFailed) throw new Error('LAUNCH_CONFIG_CLEANUP_FAILED');
        // Capture a receipt/PID before credentials are removed. The bundle keeps
        // only that PID for display observation after authority is gone.
        if (resource.bundle) await sample(resource.bundle);
        await resource.bundle?.cleanup();
      });
      let bundle: T;
      try { bundle = await this.options.prepare(manifest); finish({ bundle }); }
      catch (error) {
        finish({ cleanupFailed: error instanceof Error && error.message === 'LAUNCH_CONFIG_CLEANUP_FAILED' });
        throw error;
      }
      if (bridge.currentLaunchId() !== launchId) return { ok: false, code: 'REVOKED' };
      const exited = () => { void bridge.notifyClaudeExit(id); };
      this.options.spawn(bundle, exited);
      if (bridge.currentLaunchId() !== id) return { ok: false, code: 'LAUNCH_FAILED' };
      timer = setInterval(() => { void sample(bundle); }, this.options.pollMs ?? 500);
      return { ok: true };
    } catch (error) {
      if (launchId) { bridge.observeClient(launchId, 'failed'); await bridge.notifyClaudeExit(launchId); }
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'LAUNCH_FAILED';
      return { ok: false, code };
    } finally { this.pending = false; }
  }
}
