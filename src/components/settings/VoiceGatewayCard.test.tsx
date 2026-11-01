// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceGatewayCard } from './VoiceGatewayCard';
import type { RemoteSessionInfo } from '../../shared/remote/types';
import type { VoiceStatus } from '../../shared/voice/types';

function mkStatus(patch: Partial<VoiceStatus> = {}): VoiceStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47822', connected: false, session: 'ready', sessions: [], pairingActive: false, notice: null, ...patch };
}
function mkSession(ref: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo {
  return { ref, createdAtMs: Date.now() - 3600_000, expiresAtMs: Date.now() + 86400_000, lastSeenMs: Date.now() - 120_000, ...patch };
}

interface Opts {
  status?: VoiceStatus;
  setEnabled?: VoiceStatus;
  pairing?: unknown;
}
function install(o: Opts = {}) {
  let push: (s: VoiceStatus) => void = () => {};
  const unsubscribe = vi.fn();
  const voice = {
    status: vi.fn().mockResolvedValue(o.status ?? mkStatus()),
    setEnabled: vi.fn().mockResolvedValue(o.setEnabled ?? mkStatus()),
    createPairing: vi.fn().mockResolvedValue(o.pairing ?? { ok: true, code: 'ABCD-1234', address: '100.1.2.3:47822', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', expiresAtMs: Date.now() + 90_000 }),
    revokeAll: vi.fn().mockResolvedValue(mkStatus()),
    revokeOne: vi.fn().mockResolvedValue(mkStatus()),
    onStatus: vi.fn((cb: (s: VoiceStatus) => void) => { push = cb; return unsubscribe; }),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { voice };
  return { voice, unsubscribe, push: (s: VoiceStatus) => push(s) };
}
const settle = () => act(async () => {});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (window as { aetherElectron?: unknown }).aetherElectron;
  vi.restoreAllMocks();
});

async function pairFlow() {
  const h = install();
  render(<VoiceGatewayCard />);
  await settle();
  fireEvent.click(screen.getByText('PAIR A PHONE'));
  await settle();
  return h;
}

describe('VoiceGatewayCard', () => {
  it('shows a no-bridge message in browser mode', () => {
    render(<VoiceGatewayCard />);
    expect(screen.getByText('Available in the desktop app')).toBeTruthy();
  });

  it('off state shows ENABLE, no pair button, but the paired list', async () => {
    install({ status: mkStatus({ state: 'off', address: null, session: 'none', sessions: [mkSession('abcdef123456')] }) });
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('PAIR A PHONE')).toBeNull();
    expect(screen.getByText(/id abcdef/)).toBeTruthy();
    expect(screen.getByTestId('voice-status-line').textContent).toBe('off');
  });

  it('enable renders the readback and mapped message, not the request', async () => {
    const { voice } = install({
      status: mkStatus({ state: 'off', address: null }),
      setEnabled: mkStatus({ state: 'unavailable', reason: 'no-tailnet-address', address: null }),
    });
    render(<VoiceGatewayCard />);
    await settle();
    fireEvent.click(screen.getByText('ENABLE'));
    await settle();
    expect(voice.setEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('voice-status-line').textContent).toBe('unavailable: Tailscale address not found');
    expect(screen.queryByText('PAIR A PHONE')).toBeNull();
  });

  it('a declined confirm (unchanged status returned) leaves it off', async () => {
    const { voice } = install({ status: mkStatus({ state: 'off', address: null }), setEnabled: mkStatus({ state: 'off', address: null }) });
    render(<VoiceGatewayCard />);
    await settle();
    fireEvent.click(screen.getByText('ENABLE'));
    await settle();
    expect(voice.setEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('voice-status-line').textContent).toBe('off');
    expect(screen.getByText('ENABLE')).toBeTruthy();
  });

  it('maps port-in-use and error reasons', async () => {
    const { push } = install({ status: mkStatus({ state: 'unavailable', reason: 'port-in-use', address: null }) });
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByTestId('voice-status-line').textContent).toBe('unavailable: port in use');
    act(() => push(mkStatus({ state: 'unavailable', reason: 'error', address: null })));
    expect(screen.getByTestId('voice-status-line').textContent).toBe('unavailable: error');
  });

  it('shows the on status line', async () => {
    install({ status: mkStatus({ connected: true, session: 'restarting' }) });
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByTestId('voice-status-line').textContent).toBe('on - 100.1.2.3:47822 - phone connected - session restarting');
  });

  it('session none is idle, session starting stays starting', async () => {
    const { push } = install({ status: mkStatus({ session: 'none' }) });
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByTestId('voice-status-line').textContent).toBe('on - 100.1.2.3:47822 - phone not connected - session idle (starts when a phone connects)');
    act(() => push(mkStatus({ session: 'starting' })));
    expect(screen.getByTestId('voice-status-line').textContent).toBe('on - 100.1.2.3:47822 - phone not connected - session starting');
  });

  it('the pairing box says the code stays valid after Done until used or expired', async () => {
    await pairFlow();
    const text = screen.getByText(/Done only hides this code/).textContent!;
    for (const k of ['still works', 'used once', 'replaced by a new code', 'gateway is turned off', 'wrong codes', 'expires']) expect(text).toContain(k);
    expect(text).not.toContain('60 minutes');
  });

  it('PAIR A PHONE ignores a second click while pending and recovers after resolve and reject', async () => {
    const h = install();
    let resolve!: (v: unknown) => void;
    h.voice.createPairing.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<VoiceGatewayCard />);
    await settle();
    const btn = () => screen.getByText('PAIR A PHONE') as HTMLButtonElement;
    fireEvent.click(btn());
    fireEvent.click(btn());
    expect(h.voice.createPairing).toHaveBeenCalledTimes(1);
    expect(btn().disabled).toBe(true);
    await act(async () => { resolve({ ok: true, code: 'ABCD-1234', address: 'a', qrSvg: '<svg/>', expiresAtMs: Date.now() + 90_000 }); });
    expect(btn().disabled).toBe(false);
    h.voice.createPairing.mockRejectedValueOnce(new Error('x'));
    fireEvent.click(btn());
    await settle();
    expect(h.voice.createPairing).toHaveBeenCalledTimes(2);
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    await settle();
    expect(h.voice.createPairing).toHaveBeenCalledTimes(3);
  });

  it('a status push updates the UI', async () => {
    const { push } = install();
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByText('No phones paired')).toBeTruthy();
    act(() => push(mkStatus({ connected: true, session: 'down', sessions: [mkSession('cccccc333333')] })));
    expect(screen.getByText(/id cccccc/)).toBeTruthy();
    expect(screen.getByTestId('voice-status-line').textContent).toContain('phone connected - session down');
  });

  it('PAIR A PHONE renders an img with a data URL and the code', async () => {
    await pairFlow();
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')!.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(document.querySelector('svg')).toBeNull();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/Expires in 01:3\d|Expires in 01:30/)).toBeTruthy();
  });

  it('the code and QR are gone after Done', async () => {
    await pairFlow();
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('the code and QR are gone after the countdown expires', async () => {
    vi.useFakeTimers();
    install({ pairing: { ok: true, code: 'ABCD-1234', address: 'a', qrSvg: '<svg/>', expiresAtMs: Date.now() + 5_000 } });
    render(<VoiceGatewayCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByText('PAIR A PHONE'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('after unmount the code is gone, the timer is cleared and nothing warns', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    install({ pairing: { ok: true, code: 'ABCD-1234', address: 'a', qrSvg: '<svg/>', expiresAtMs: Date.now() + 5_000 } });
    const { unmount } = render(<VoiceGatewayCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByText('PAIR A PHONE'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(document.body.textContent).not.toContain('ABCD-1234');
    expect(document.querySelector('img')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(err).not.toHaveBeenCalled();
  });

  it('REVOKE calls revokeOne with that row full ref', async () => {
    const { voice } = install({ status: mkStatus({ sessions: [mkSession('aaaaaa111111'), mkSession('bbbbbb222222')] }) });
    render(<VoiceGatewayCard />);
    await settle();
    fireEvent.click(screen.getAllByText('REVOKE')[1]);
    await settle();
    expect(voice.revokeOne).toHaveBeenCalledTimes(1);
    expect(voice.revokeOne).toHaveBeenCalledWith('bbbbbb222222');
    expect(voice.revokeAll).not.toHaveBeenCalled();
  });

  it('REVOKE ALL PHONES calls revokeAll, also while off', async () => {
    const { voice } = install({ status: mkStatus({ state: 'off', address: null, sessions: [mkSession('aaaaaa111111')] }) });
    render(<VoiceGatewayCard />);
    await settle();
    fireEvent.click(screen.getByText('REVOKE ALL PHONES'));
    await settle();
    expect(voice.revokeAll).toHaveBeenCalledTimes(1);
    expect(voice.revokeOne).not.toHaveBeenCalled();
    expect(screen.getByText('No phones paired')).toBeTruthy();
  });

  it('shows the status notice', async () => {
    install({ status: mkStatus({ sessions: [mkSession('aaaaaa111111')], notice: 'Revoke not saved to disk yet' }) });
    render(<VoiceGatewayCard />);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Revoke not saved to disk yet');
  });

  it('renders no field other than the listed ones', async () => {
    const junk = { ...mkSession('dddddd444444'), userAgent: 'JUNK-UA', ip: '9.9.9.9', hash: 'JUNKHASH', token: 'JUNKTOKEN' };
    install({ status: mkStatus({ sessions: [junk] }) });
    render(<VoiceGatewayCard />);
    await settle();
    const text = document.body.textContent!;
    for (const j of ['JUNK-UA', '9.9.9.9', 'JUNKHASH', 'JUNKTOKEN', 'dddddd444444']) expect(text).not.toContain(j);
    expect(text).toContain('id dddddd');
  });

  it('touches neither localStorage nor sessionStorage in a pairing flow', async () => {
    const spies = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
    ];
    await pairFlow();
    fireEvent.click(screen.getByText('Done'));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('a push that leaves on drops the code and it does not return', async () => {
    const { push } = await pairFlow();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    act(() => push(mkStatus({ state: 'off', address: null })));
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    act(() => push(mkStatus()));
    expect(screen.queryByText('ABCD-1234')).toBeNull();
  });

  it('unsubscribes from onStatus on unmount', async () => {
    const { unsubscribe } = install();
    const { unmount } = render(<VoiceGatewayCard />);
    await settle();
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
