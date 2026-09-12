import type { CommunicationBridgeIntegration } from './mainIntegration';
import type { SessionResult } from './sessionControl';

/** A modal confirmation is scoped to the launch that existed when it opened. */
export class CommunicationGrantControl {
  private pending = false;
  constructor(private readonly bridge: CommunicationBridgeIntegration,
    private readonly confirm: () => Promise<boolean>) {}
  async grant(confirmationId: string): Promise<SessionResult> {
    if (this.pending) return { ok: false, code: 'BUSY' };
    const launchId = this.bridge.currentLaunchId();
    if (!launchId || this.bridge.snapshot().readiness !== 'ready') return { ok: false, code: 'NOT_CONNECTED' };
    this.pending = true;
    try {
      if (!await this.confirm()) return { ok: false, code: 'CANCELLED' };
      return this.bridge.grantCreditsForLaunch(launchId, confirmationId)
        ? { ok: true } : { ok: false, code: 'GRANT_NOT_APPLIED' };
    } finally { this.pending = false; }
  }
}
