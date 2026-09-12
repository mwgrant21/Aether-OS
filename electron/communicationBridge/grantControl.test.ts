import { describe, expect, it, vi } from 'vitest';
import { CommunicationGrantControl } from './grantControl';
describe('operator credit confirmation', () => {
  it('binds to the launch shown and refuses duplicate concurrent confirmations', async () => {
    let launch = 'first', answer!: (value: boolean) => void;
    const grantCreditsForLaunch = vi.fn((id: string) => id === launch);
    const bridge = { currentLaunchId: () => launch, snapshot: () => ({ readiness: 'ready' }), grantCreditsForLaunch };
    const control = new CommunicationGrantControl(bridge as never, () => new Promise(resolve => { answer = resolve; }));
    const pending = control.grant('confirmation');
    expect(await control.grant('confirmation')).toEqual({ ok: false, code: 'BUSY' });
    launch = 'replacement'; answer(true);
    expect(await pending).toEqual({ ok: false, code: 'GRANT_NOT_APPLIED' });
    expect(grantCreditsForLaunch).toHaveBeenCalledWith('first', 'confirmation');
  });
  it('cancelled or disconnected confirmations never grant', async () => {
    const grantCreditsForLaunch = vi.fn();
    const bridge = { currentLaunchId: () => 'id', snapshot: () => ({ readiness: 'ready' }), grantCreditsForLaunch };
    const control = new CommunicationGrantControl(bridge as never, async () => false);
    expect(await control.grant('id')).toEqual({ ok: false, code: 'CANCELLED' });
    bridge.snapshot = () => ({ readiness: 'disconnected' });
    expect(await control.grant('id')).toEqual({ ok: false, code: 'NOT_CONNECTED' });
    expect(grantCreditsForLaunch).not.toHaveBeenCalled();
  });
});
