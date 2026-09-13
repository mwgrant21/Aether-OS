import { randomBytes, randomUUID } from 'node:crypto';
import { CodexAppServerAdapter } from '../crossEngine/providers/codexAppServer';
import { ExchangeController, type ExchangeControllerOptions } from './exchangeController';
import { startPipeServer, type PipeServerOptions } from './pipeServer';
import { isCommunicationPrompt, type CommunicationSessionStatus } from '../../src/shared/communicationSessionStatus';
import type { CommunicationMetadata, CommunicationPayload } from '../../src/shared/communicationTypes';

export interface CommunicationBridgeSnapshot {
  readonly enabled: boolean;
  readonly sessionStatus: CommunicationSessionStatus;
  readonly readiness: 'disabled' | 'waiting' | 'authenticated' | 'ready' | 'disconnected';
  readonly cleanup: 'confirmed' | 'pending' | 'failed';
  readonly metadata: readonly CommunicationMetadata[];
  readonly remainingCredits?: number | null;
}
export type BridgeShutdownResult = { readonly ok: true } | {
  readonly ok: false; readonly code: 'CLEANUP_FAILED' | 'SHUTDOWN_TIMEOUT' | 'SHUTTING_DOWN' | 'DISPOSED';
};
/** Main-only launch credential. Never return this through renderer IPC. */
export interface CommunicationLaunchManifest {
  readonly launchId: string; readonly endpoint: string; readonly capability: string;
}
type Listener = Awaited<ReturnType<typeof startPipeServer>>;
interface Launch {
  sessionLabel: string; prompt: CommunicationSessionStatus['prompt'];
  id: string; valid: boolean; authenticated: boolean; listed: boolean;
  listening: Promise<Listener>; closing?: Promise<void>;
  cleanupCallbacks: Set<() => Promise<void>>;
}
async function awaitCleanup(work: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(work);
  if (results.some(result => result.status === 'rejected')) throw new Error('CLEANUP_FAILED');
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
  private readonly instanceLabel = `Instance ${randomBytes(8).toString('hex')}`;
  private sessionSequence = 0;
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private current?: Launch;
  private serial: Promise<void> = Promise.resolve();
  private disabling?: Promise<void>;
  private disablePending = false;
  private cleanup: CommunicationBridgeSnapshot['cleanup'] = 'confirmed';
  private readonly closing = new Set<Promise<void>>();
  private readonly cleanupCallbacks = new WeakMap<() => Promise<void>, Promise<void>>();
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
      sessionStatus: { instanceLabel: this.instanceLabel, sessionLabel: this.current?.sessionLabel ?? null,
        prompt: this.current?.prompt ?? 'unknown' },
      readiness: !this.enabled ? 'disabled' : !this.current ? 'disconnected'
        : this.current.authenticated && this.current.listed ? 'ready'
          : this.current.authenticated ? 'authenticated' : 'waiting',
      cleanup: this.cleanup === 'failed' ? 'failed'
        : this.cleanup === 'pending' || this.closing.size > 0 || controllerCleanup === 'pending' ? 'pending' : 'confirmed',
      metadata, ...(this.current ? { remainingCredits: this.controller.remainingCredits() } : {}) };
  }
  private emit(): void {
    const snapshot = this.snapshot(); // Authority bookkeeping must not depend on a mounted UI subscriber.
    try { this.options.onSnapshot?.(snapshot); } catch { /* UI cannot change authority. */ }
  }
  setEnabled(enabled: boolean): Promise<BridgeShutdownResult> {
    if (enabled) {
      if (this.disablePending || this.closing.size > 0) return Promise.resolve({ ok: false, code: 'SHUTTING_DOWN' });
      if (this.cleanup === 'failed') return Promise.resolve({ ok: false, code: 'CLEANUP_FAILED' });
      if (this.disposed) return Promise.resolve({ ok: false, code: 'DISPOSED' });
      this.disabling = undefined;
      this.enabled = true; this.controller.setEnabled(true); this.emit();
      return Promise.resolve({ ok: true });
    }
    // Re-observe the owned operation. A deadline never starts another disposal.
    if (this.disabling) return this.bounded(awaitCleanup([this.disabling, ...this.closing]));
    this.enabled = false; this.epoch++;
    this.revokeCurrent();
    // Erasure/revocation precede the first await, even when a provider never exits.
    this.controller.setEnabled(false); if (this.cleanup !== 'failed') this.cleanup = 'pending'; this.emit();
    this.disablePending = true;
    const cleanup = awaitCleanup([this.serial, ...this.closing, this.controller.dispose()]);
    this.disabling = cleanup;
    // Observe completion even after every bounded caller has timed out. Wait for
    // all owners, including when one rejects before the others have completed.
    void cleanup.then(() => {
      this.disablePending = false;
      if (this.cleanup !== 'failed') this.cleanup = 'confirmed';
      this.emit();
    }, () => { this.disablePending = false; this.cleanup = 'failed'; this.emit(); });
    return this.bounded(cleanup);
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
      const launch: Launch = { sessionLabel: `Session ${++this.sessionSequence}`, prompt: 'unknown', id: randomUUID(), valid: true, authenticated: false, listed: false,
        listening: Promise.resolve(undefined as unknown as Listener), cleanupCallbacks: new Set() };
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
    return this.bounded(awaitCleanup([...this.closing]));
  }
  /** Main-only observation seam. Neither labels nor prompt state grant authority.
   * Reject stale observations after replacement/revocation. */
  observePrompt(launchId: string, prompt: CommunicationSessionStatus['prompt']): boolean {
    const launch = this.current;
    if (!this.enabled || this.disposed || !launch?.valid || launch.id !== launchId || !isCommunicationPrompt(prompt)) return false;
    if (launch.prompt !== prompt) { launch.prompt = prompt; this.emit(); }
    return true;
  }
  currentLaunchId(): string | undefined { return this.current?.id; }
  /** Reserve ownership before starting asynchronous creation of launch files.
   * A stale attachment is cleaned immediately and never gains launch authority. */
  attachLaunchCleanup(launchId: string, cleanup: () => Promise<void>): void {
    if (this.current?.id === launchId && this.current.valid) this.current.cleanupCallbacks.add(cleanup);
    else { this.trackClosing(this.runCleanup(cleanup)); this.emit(); }
  }
  private runCleanup(cleanup: () => Promise<void>): Promise<void> {
    const existing = this.cleanupCallbacks.get(cleanup);
    if (existing) return existing;
    const work = Promise.resolve().then(cleanup);
    this.cleanupCallbacks.set(cleanup, work); return work;
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
    const closing = awaitCleanup([launch.listening.then(listener => listener.close(), () => {}),
      ...[...launch.cleanupCallbacks].map(cleanup => this.runCleanup(cleanup))]);
    launch.closing = closing; this.trackClosing(closing);
    return closing;
  }
  private trackClosing(closing: Promise<void>): void {
    this.closing.add(closing);
    void closing.then(() => { this.closing.delete(closing); this.emit(); }, () => {
      this.closing.delete(closing); this.cleanup = 'failed'; this.emit();
    });
  }
  private async bounded(work: Promise<void>): Promise<BridgeShutdownResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = await Promise.race<BridgeShutdownResult>([
      work.then(() => ({ ok: true as const }), () => ({ ok: false as const, code: 'CLEANUP_FAILED' as const })),
      new Promise<BridgeShutdownResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, code: 'SHUTDOWN_TIMEOUT' }), this.shutdownMs); }),
    ]);
    clearTimeout(timer);
    if (result.ok && this.cleanup === 'failed') result = { ok: false, code: 'CLEANUP_FAILED' };
    if (!result.ok && result.code === 'CLEANUP_FAILED') this.cleanup = 'failed';
    this.emit(); return result;
  }
  readPayload(id: string): CommunicationPayload | undefined { return this.controller.readPayload(id); }
  clear(id: string): void { this.controller.clear(id); }
  cancel(id: string): void { this.controller.cancelFromOperator(id); }
  /** U6 supplies its explicit operator confirmation flow; no U5 IPC grants. */
  grantCredits(confirmationId: string): void { this.controller.grantCredits(confirmationId); }
  grantCreditsForLaunch(launchId: string, confirmationId: string): boolean {
    if (!this.enabled || this.disposed || this.current?.id !== launchId || !this.current.valid
      || this.snapshot().cleanup === 'failed') return false;
    const before = this.controller.remainingCredits();
    this.controller.grantCredits(confirmationId);
    return this.controller.remainingCredits() !== before;
  }
  dispose(): Promise<BridgeShutdownResult> {
    this.disposed = true; return this.setEnabled(false);
  }
}
