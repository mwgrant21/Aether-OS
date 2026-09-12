import type { CommunicationBridgeIntegration, CommunicationLaunchManifest } from './mainIntegration';

export type SessionResult = { ok: true } | { ok: false; code: string };
export interface LaunchBundle {
  completion(): Promise<'running' | 'exited' | 'failed'>;
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
      // Reserve cleanup BEFORE starting asynchronous file creation. Disable owns
      // this same operation even if the resource appears after revocation.
      let finish!: (resource: { bundle?: T; cleanupFailed?: boolean }) => void;
      const created = new Promise<{ bundle?: T; cleanupFailed?: boolean }>(resolve => { finish = resolve; });
      bridge.attachLaunchCleanup(launchId, async () => {
        clearInterval(timer);
        const resource = await created;
        if (resource.cleanupFailed) throw new Error('LAUNCH_CONFIG_CLEANUP_FAILED');
        await resource.bundle?.cleanup();
      });
      let bundle: T;
      try { bundle = await this.options.prepare(manifest); finish({ bundle }); }
      catch (error) {
        finish({ cleanupFailed: error instanceof Error && error.message === 'LAUNCH_CONFIG_CLEANUP_FAILED' });
        throw error;
      }
      if (bridge.currentLaunchId() !== launchId) return { ok: false, code: 'REVOKED' };
      const id = launchId;
      const exited = () => { void bridge.notifyClaudeExit(id); };
      this.options.spawn(bundle, exited);
      if (bridge.currentLaunchId() !== id) return { ok: false, code: 'LAUNCH_FAILED' };
      let reading = false;
      timer = setInterval(() => {
        if (reading) return;
        reading = true;
        void bundle.completion().then(state => { if (state !== 'running') exited(); }, exited)
          .finally(() => { reading = false; });
      }, this.options.pollMs ?? 500);
      return { ok: true };
    } catch (error) {
      if (launchId) await bridge.notifyClaudeExit(launchId);
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'LAUNCH_FAILED';
      return { ok: false, code };
    } finally { this.pending = false; }
  }
}
