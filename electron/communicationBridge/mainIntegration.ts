import { randomBytes, randomUUID } from 'node:crypto';
import { CodexAppServerAdapter } from '../crossEngine/providers/codexAppServer';
import { ExchangeController, type ExchangeControllerOptions } from './exchangeController';
import { startPipeServer, type PipeServerOptions } from './pipeServer';
import type { CommunicationMetadata, CommunicationPayload } from '../../src/shared/communicationTypes';

export interface CommunicationBridgeSnapshot {
  readonly enabled: boolean;
  readonly readiness: 'disabled' | 'waiting' | 'authenticated' | 'ready' | 'disconnected';
  readonly cleanup: 'confirmed' | 'pending' | 'failed';
  readonly metadata: readonly CommunicationMetadata[];
}
export type BridgeShutdownResult = { readonly ok: true } | {
  readonly ok: false; readonly code: 'CLEANUP_FAILED' | 'SHUTDOWN_TIMEOUT';
};
/** Main-only launch credential. Never return this through renderer IPC. */
export interface CommunicationLaunchManifest {
  readonly launchId: string; readonly endpoint: string; readonly capability: string;
}
type Listener = Awaited<ReturnType<typeof startPipeServer>>;
interface Launch {
  id: string; valid: boolean; authenticated: boolean; listed: boolean;
  listening: Promise<Listener>; closing?: Promise<void>;
}
export interface CommunicationBridgeOptions extends Omit<ExchangeControllerOptions, 'providerFactory' | 'onMetadata'> {
  providerFactory?: ExchangeControllerOptions['providerFactory'];
  startListener?: (options: PipeServerOptions) => Promise<Listener>;
  shutdownMs?: number;
  onSnapshot?: (snapshot: CommunicationBridgeSnapshot) => void;
}

/** Main owns one instance from bootstrap, independently of Settings mounting.
 * The controller starts disabled, and only main-held launch facades reach a pipe.
 * Lifecycle invalidation is synchronous; waiting is solely for cleanup evidence. */
export class CommunicationBridgeIntegration {
  private readonly controller: ExchangeController;
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private current?: Launch;
  private serial: Promise<void> = Promise.resolve();
  private disabling?: Promise<BridgeShutdownResult>;
  private shutdown?: Promise<BridgeShutdownResult>;
  private cleanup: CommunicationBridgeSnapshot['cleanup'] = 'confirmed';
  private readonly closing = new Set<Promise<void>>();
  private readonly shutdownMs: number;
  constructor(private readonly options: CommunicationBridgeOptions = {}) {
    this.shutdownMs = options.shutdownMs ?? 12_000;
    if (!Number.isFinite(this.shutdownMs) || this.shutdownMs < 1 || this.shutdownMs > 30_000)
      throw new Error('Invalid bridge shutdown deadline');
    this.controller = new ExchangeController({ ...options,
      providerFactory: options.providerFactory ?? (cwd => new CodexAppServerAdapter(undefined, undefined, cwd)),
      onMetadata: () => this.emit(),
    });
  }
  snapshot(): CommunicationBridgeSnapshot {
    const metadata = this.controller.metadata();
    const controllerCleanup = this.controller.cleanupStatus();
    if (controllerCleanup === 'failed') this.cleanup = 'failed';
    return { enabled: this.enabled,
      readiness: !this.enabled ? 'disabled' : !this.current ? 'disconnected'
        : this.current.authenticated && this.current.listed ? 'ready'
          : this.current.authenticated ? 'authenticated' : 'waiting',
      cleanup: this.cleanup === 'failed' ? 'failed'
        : this.cleanup === 'pending' || controllerCleanup === 'pending' ? 'pending' : 'confirmed',
      metadata };
  }
  private emit(): void {
    const snapshot = this.snapshot(); // Authority bookkeeping must not depend on a mounted UI subscriber.
    try { this.options.onSnapshot?.(snapshot); } catch { /* UI cannot change authority. */ }
  }
  setEnabled(enabled: boolean): Promise<BridgeShutdownResult> {
    if (enabled) {
      if (this.disposed || this.disabling || this.cleanup === 'failed')
        return Promise.resolve({ ok: false, code: 'CLEANUP_FAILED' });
      this.enabled = true; this.controller.setEnabled(true); this.emit();
      return Promise.resolve({ ok: true });
    }
    if (this.disabling) return this.disabling;
    this.enabled = false; this.epoch++;
    this.revokeCurrent();
    // Erasure/revocation precede the first await, even when a provider never exits.
    this.controller.setEnabled(false); if (this.cleanup !== 'failed') this.cleanup = 'pending'; this.emit();
    const cleanup = Promise.all([this.serial, ...this.closing, this.controller.dispose()]).then(() => {});
    const result = this.bounded(cleanup, true);
    this.disabling = result;
    void result.then(() => { if (this.disabling === result) this.disabling = undefined; });
    return result;
  }
  prepareLaunch(): Promise<CommunicationLaunchManifest> {
    const epoch = this.epoch;
    const operation = this.serial.then(async () => {
      if (!this.enabled || this.disposed || epoch !== this.epoch || this.snapshot().cleanup === 'failed')
        throw new Error('Bridge unavailable');
      this.revokeCurrent();
      await Promise.all(this.closing);
      if (!this.enabled || this.disposed || epoch !== this.epoch || this.snapshot().cleanup === 'failed')
        throw new Error('Bridge unavailable');
      const capability = randomBytes(32).toString('base64url');
      const launch: Launch = { id: randomUUID(), valid: true, authenticated: false, listed: false,
        listening: Promise.resolve(undefined as unknown as Listener) };
      this.current = launch;
      const client = this.controller.openLaunch();
      const active = () => launch.valid && this.current === launch && this.enabled && epoch === this.epoch;
      launch.listening = Promise.resolve().then(() => (this.options.startListener ?? startPipeServer)({ capability, client,
        onAuthenticated: () => { if (active()) { launch.authenticated = true; this.emit(); } },
        onToolsListed: () => { if (active()) { launch.listed = true; this.emit(); } },
        onDisconnect: () => { if (active()) void this.notifyClaudeExit(launch.id); },
      }));
      this.emit();
      let listener: Listener;
      try { listener = await launch.listening; }
      catch { if (this.current === launch) this.revokeCurrent(); throw new Error('Bridge unavailable'); }
      if (!active()) { await this.closeLaunch(launch); throw new Error('Bridge unavailable'); }
      return { launchId: launch.id, endpoint: listener.endpoint, capability };
    });
    this.serial = operation.then(() => {}, () => {});
    return operation;
  }
  notifyClaudeExit(launchId: string): Promise<BridgeShutdownResult> {
    if (this.current?.id !== launchId) return Promise.resolve({ ok: true });
    this.epoch++; this.revokeCurrent(); this.emit();
    return this.bounded(Promise.all(this.closing).then(() => {}));
  }
  private revokeCurrent(): void {
    const launch = this.current;
    if (!launch) return;
    launch.valid = false; this.current = undefined;
    this.controller.disconnect();
    void this.closeLaunch(launch).catch(() => {});
  }
  private closeLaunch(launch: Launch): Promise<void> {
    if (launch.closing) return launch.closing;
    // A listener still starting is closed as soon as it becomes available.
    const closing = launch.listening.then(listener => listener.close(), () => {});
    launch.closing = closing; this.closing.add(closing);
    void closing.then(() => this.closing.delete(closing), () => {
      this.closing.delete(closing); this.cleanup = 'failed'; this.emit();
    });
    return closing;
  }
  private async bounded(work: Promise<void>, completesDisable = false): Promise<BridgeShutdownResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = await Promise.race<BridgeShutdownResult>([
      work.then(() => ({ ok: true as const }), () => ({ ok: false as const, code: 'CLEANUP_FAILED' as const })),
      new Promise<BridgeShutdownResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, code: 'SHUTDOWN_TIMEOUT' }), this.shutdownMs); }),
    ]);
    clearTimeout(timer);
    if (result.ok && this.cleanup === 'failed') result = { ok: false, code: 'CLEANUP_FAILED' };
    if (!result.ok) this.cleanup = 'failed';
    else if (completesDisable && this.cleanup !== 'failed') this.cleanup = 'confirmed';
    this.emit(); return result;
  }
  readPayload(id: string): CommunicationPayload | undefined { return this.controller.readPayload(id); }
  clear(id: string): void { this.controller.clear(id); }
  cancel(id: string): void { this.controller.cancelFromOperator(id); }
  /** U6 supplies its explicit operator confirmation flow; no U5 IPC grants. */
  grantCredits(confirmationId: string): void { this.controller.grantCredits(confirmationId); }
  dispose(): Promise<BridgeShutdownResult> {
    if (this.shutdown) return this.shutdown;
    this.disposed = true; return this.shutdown = this.setEnabled(false);
  }
}
