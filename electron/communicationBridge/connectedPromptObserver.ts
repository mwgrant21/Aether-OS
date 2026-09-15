import { PtyLifecycle, type PtyLike, type PtyLifecycleHandlers } from '../ptyLifecycle';
import type { CommunicationBridgeIntegration } from './mainIntegration';
import { createTrustPromptMatcher } from './trustPromptMatcher';

/** Main-only observation: both the physical terminal and launch must still own
 * the bytes. This never derives readiness, absence, or exit from matcher state. */
export class ConnectedPromptObserver {
  private current: { pty: PtyLike; launchId: string; matcher: ReturnType<typeof createTrustPromptMatcher>; resizeDepth: number; resizeAmbiguous: boolean } | undefined;
  constructor(private readonly lifecycle: PtyLifecycle,
    private readonly bridge: Pick<CommunicationBridgeIntegration, 'currentLaunchId' | 'observePrompt'>) {}

  start(launchId: string, dimensions: { cols: number; rows: number }, spawn: () => PtyLike, handlers: PtyLifecycleHandlers): void {
    // A new matcher is a fresh physical session, never a same-terminal reset.
    // Invalidate ownership before replacement can synchronously emit old bytes.
    this.current = undefined;
    this.bridge.observePrompt(launchId, 'unknown');
    let owner: NonNullable<ConnectedPromptObserver['current']> | undefined;
    const publish = () => {
      if (owner && this.owns(owner) && owner.resizeDepth === 0)
        this.bridge.observePrompt(launchId, owner.matcher.state().active ? 'folder-trust' : 'unknown');
    };
    try {
      this.lifecycle.start(() => {
        const pty = spawn();
        owner = { pty, launchId, matcher: createTrustPromptMatcher(Date.now, dimensions), resizeDepth: 0, resizeAmbiguous: false };
        this.current = owner;
        return pty;
      }, {
        onData: data => {
          if (owner && this.owns(owner)) { owner.matcher.ingest(data); publish(); }
          handlers.onData(data);
        },
        onAlive: handlers.onAlive,
        onExit: () => {
          if (owner && this.current === owner) {
            this.bridge.observePrompt(launchId, 'unknown');
            this.current = undefined;
          }
          handlers.onExit();
        },
      });
    } catch (error) {
      if (this.current === owner) this.current = undefined;
      this.bridge.observePrompt(launchId, 'unknown');
      throw error;
    }
  }

  /** Call before native resize: even synchronously emitted output sees new
   * dimensions. A failed resize leaves unknown evidence, never the old prompt. */
  resize(cols: number, rows: number): void {
    const owner = this.current && this.owns(this.current) ? this.current : undefined;
    if (owner) {
      // Nested native resizes have ambiguous final geometry. Wait for a later
      // independent resize rather than claiming either request won.
      owner.resizeAmbiguous = owner.resizeDepth > 0;
      owner.resizeDepth++;
      owner.matcher.resize(cols, rows);
      this.bridge.observePrompt(owner.launchId, 'unknown');
    }
    try { this.lifecycle.resize(cols, rows); }
    catch (error) {
      if (owner) owner.resizeAmbiguous = true;
      throw error;
    } finally {
      if (owner) {
        // Poison evidence before releasing the publication guard. Synchronous
        // native output may have painted a prompt before resize threw.
        if (owner.resizeAmbiguous) owner.matcher.resize(Number.NaN, Number.NaN);
        owner.resizeDepth--;
        if (this.owns(owner) && owner.resizeDepth === 0)
          this.bridge.observePrompt(owner.launchId, owner.matcher.state().active ? 'folder-trust' : 'unknown');
      }
    }
  }
  private owns(owner: NonNullable<ConnectedPromptObserver['current']>): boolean {
    return this.current === owner && this.lifecycle.current === owner.pty
      && this.bridge.currentLaunchId() === owner.launchId;
  }
}
