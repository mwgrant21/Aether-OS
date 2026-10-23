// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoteAccessCard } from './RemoteAccessCard';
import type { RemoteSessionInfo, RemoteStatus } from '../../shared/remote/types';

function mkStatus(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return { state: 'on', reason: null, address: '100.1.2.3:47821', clients: 1, sessions: [], pairingActive: false, following: true, notice: null, ...patch };
}
function mkSession(ref: string, patch: Partial<RemoteSessionInfo> = {}): RemoteSessionInfo {
  return { ref, createdAtMs: Date.now() - 3600_000, expiresAtMs: Date.now() + 86400_000, lastSeenMs: Date.now() - 120_000, ...patch };
}

interface Opts {
  status?: RemoteStatus;
  setEnabled?: RemoteStatus;
  pairing?: unknown;
}
function install(o: Opts = {}) {
  let push: (s: RemoteStatus) => void = () => {};
  const remote = {
    status: vi.fn().mockResolvedValue(o.status ?? mkStatus()),
    setEnabled: vi.fn().mockResolvedValue(o.setEnabled ?? mkStatus()),
    createPairing: vi.fn().mockResolvedValue(o.pairing ?? { ok: true, url: 'http://100.1.2.3:47821/', code: 'ABCD-1234', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', expiresAtMs: Date.now() + 90_000 }),
    revokeAll: vi.fn().mockResolvedValue(mkStatus()),
    revokeOne: vi.fn().mockResolvedValue(mkStatus()),
    onStatus: vi.fn((cb: (s: RemoteStatus) => void) => { push = cb; return vi.fn(); }),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { remote };
  return { remote, push: (s: RemoteStatus) => push(s) };
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
  render(<RemoteAccessCard />);
  await settle();
  fireEvent.click(screen.getByText('PAIR A PHONE'));
  await settle();
  return h;
}

describe('RemoteAccessCard', () => {
  it('shows a no-bridge message in browser mode', () => {
    render(<RemoteAccessCard />);
    expect(screen.getByText('Available in the desktop app')).toBeTruthy();
  });

  it('off state shows ENABLE, no pair button, but the paired list', async () => {
    install({ status: mkStatus({ state: 'off', address: null, sessions: [mkSession('abcdef123456')] }) });
    render(<RemoteAccessCard />);
    await settle();
    expect(screen.getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('PAIR A PHONE')).toBeNull();
    expect(screen.getByText(/id abcdef/)).toBeTruthy();
    expect(screen.getByTestId('remote-status-line').textContent).toBe('off');
  });

  it('enable calls setEnabled(true) and renders the readback, not the request', async () => {
    const { remote } = install({
      status: mkStatus({ state: 'off', address: null }),
      setEnabled: mkStatus({ state: 'unavailable', reason: 'no-tailnet-address', address: null }),
    });
    render(<RemoteAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('ENABLE'));
    await settle();
    expect(remote.setEnabled).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('remote-status-line').textContent).toContain('Tailscale address not found');
    expect(screen.queryByText('PAIR A PHONE')).toBeNull();
  });

  it('shows on status line and the not-pinned hint', async () => {
    install({ status: mkStatus({ clients: 2, following: false }) });
    render(<RemoteAccessCard />);
    await settle();
    expect(screen.getByTestId('remote-status-line').textContent).toBe('on - 100.1.2.3:47821 - 2 phones connected');
    expect(screen.getByText('No Claude session is pinned in Aether yet')).toBeTruthy();
  });

  it('PAIR A PHONE renders an img with a data URL and the code', async () => {
    await pairFlow();
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')!.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(document.querySelector('svg')).toBeNull();
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText(/Expires in 01:3\d|Expires in 01:30/)).toBeTruthy();
  });

  it('a not-enabled pairing result is handled without throwing', async () => {
    install({ pairing: { ok: false, reason: 'not-enabled' } });
    render(<RemoteAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('PAIR A PHONE'));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Turn remote access on first');
    expect(document.querySelector('img')).toBeNull();
  });

  it('the code is gone after Done', async () => {
    await pairFlow();
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('the code is gone after unmount', async () => {
    await pairFlow();
    cleanup();
    expect(document.body.textContent).not.toContain('ABCD-1234');
    expect(document.querySelector('img')).toBeNull();
  });

  it('the code is gone after the countdown expires', async () => {
    vi.useFakeTimers();
    install({ pairing: { ok: true, url: 'u', code: 'ABCD-1234', qrSvg: '<svg/>', expiresAtMs: Date.now() + 5_000 } });
    render(<RemoteAccessCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByText('PAIR A PHONE'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('ABCD-1234')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('REVOKE calls revokeOne with that row full ref', async () => {
    const { remote } = install({ status: mkStatus({ sessions: [mkSession('aaaaaa111111'), mkSession('bbbbbb222222')] }) });
    render(<RemoteAccessCard />);
    await settle();
    fireEvent.click(screen.getAllByText('REVOKE')[1]);
    await settle();
    expect(remote.revokeOne).toHaveBeenCalledTimes(1);
    expect(remote.revokeOne).toHaveBeenCalledWith('bbbbbb222222');
    expect(remote.revokeAll).not.toHaveBeenCalled();
  });

  it('REVOKE ALL PHONES calls revokeAll', async () => {
    const { remote } = install({ status: mkStatus({ sessions: [mkSession('aaaaaa111111')] }) });
    render(<RemoteAccessCard />);
    await settle();
    fireEvent.click(screen.getByText('REVOKE ALL PHONES'));
    await settle();
    expect(remote.revokeAll).toHaveBeenCalledTimes(1);
    expect(remote.revokeOne).not.toHaveBeenCalled();
    expect(screen.getByText('No phones paired')).toBeTruthy();
  });

  it('the list updates from an onStatus push', async () => {
    const { push } = install({ status: mkStatus() });
    render(<RemoteAccessCard />);
    await settle();
    expect(screen.getByText('No phones paired')).toBeTruthy();
    act(() => push(mkStatus({ sessions: [mkSession('cccccc333333')] })));
    expect(screen.getByText(/id cccccc/)).toBeTruthy();
  });

  it('shows the save-failure notice persistently', async () => {
    install({ status: mkStatus({ sessions: [mkSession('aaaaaa111111')], notice: 'Revoke not saved to disk yet' }) });
    render(<RemoteAccessCard />);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Revoke not saved to disk yet');
  });

  it('renders no field other than the listed ones', async () => {
    const junk = { ...mkSession('dddddd444444'), userAgent: 'JUNK-UA', ip: '9.9.9.9', hash: 'JUNKHASH', token: 'JUNKTOKEN' };
    install({ status: mkStatus({ sessions: [junk] }) });
    render(<RemoteAccessCard />);
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
});
