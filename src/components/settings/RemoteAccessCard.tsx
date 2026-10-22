import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useRemoteStatus } from '../remote/useRemoteStatus';
import type { PairingResult, RemoteSessionInfo, RemoteStatus } from '../../shared/remote/types';

type Pairing = Extract<PairingResult, { ok: true }>;

export function statusLine(s: RemoteStatus): string {
  if (s.state === 'off') return 'off';
  if (s.state === 'on') {
    return `on - ${s.address ?? 'address unknown'} - ${s.clients} phone${s.clients === 1 ? '' : 's'} connected`;
  }
  if (s.reason === 'no-tailnet-address') return 'unavailable: Tailscale address not found - is Tailscale connected?';
  if (s.reason === 'port-in-use') return 'unavailable: port in use';
  return 'unavailable: error';
}

function relative(ms: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function RemoteAccessCard() {
  const colors = useColors();
  const hookStatus = useRemoteStatus();
  // A readback returned by an action, valid only until the next push replaces the hook's status.
  const [local, setLocal] = useState<{ base: RemoteStatus | null; status: RemoteStatus } | null>(null);
  const status = local && local.base === hookStatus ? local.status : hookStatus;
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const remote = window.aetherElectron?.remote;
  const adopt = (s: RemoteStatus) => setLocal({ base: hookStatus, status: s });

  // Drop the code and QR on expiry; the interval only runs while a code is held.
  useEffect(() => {
    if (!pairing) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= pairing.expiresAtMs) setPairing(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairing]);

  // Turning access off (or it becoming unavailable) invalidates any displayed code.
  const stateNow = status?.state;
  useEffect(() => {
    if (stateNow && stateNow !== 'on') setPairing(null);
  }, [stateNow]);

  if (!remote || !status) {
    return (
      <div style={cardStyle(colors)}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>REMOTE ACCESS (READ-ONLY)</h2>
        <p style={hintStyle(colors)}>{remote ? 'Checking remote access...' : 'Available in the desktop app'}</p>
      </div>
    );
  }

  const toggle = async () => {
    setMessage(null);
    try {
      adopt(await remote.setEnabled(status.state === 'off'));
    } catch {
      setMessage('Could not change remote access.');
    }
  };
  const pair = async () => {
    setMessage(null);
    try {
      const r = await remote.createPairing();
      if (r.ok) setPairing(r);
      else setMessage('Turn remote access on first.');
    } catch {
      setMessage('Could not create a pairing code.');
    }
  };
  const revoke = async (act: () => Promise<RemoteStatus>) => {
    try {
      adopt(await act());
    } catch {
      setMessage('Could not revoke.');
    }
  };

  const on = status.state === 'on';
  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>REMOTE ACCESS (READ-ONLY)</h2>
        <Button onClick={() => void toggle()} style={buttonStyle(colors, on)}>
          {status.state === 'off' ? 'ENABLE' : 'DISABLE'}
        </Button>
      </div>
      <p style={hintStyle(colors)} data-testid="remote-status-line">{statusLine(status)}</p>
      {on && !status.following && <p style={hintStyle(colors)}>No Claude session is pinned in Aether yet</p>}
      {message && <p role="alert" style={hintStyle(colors)}>{message}</p>}

      {on && (
        <div style={{ marginTop: 10 }}>
          <Button onClick={() => void pair()} style={buttonStyle(colors, false)}>PAIR A PHONE</Button>
        </div>
      )}
      {pairing && (
        <div style={boxStyle(colors)}>
          <img
            alt="Pairing QR code"
            width={160}
            height={160}
            style={{ background: '#fff', display: 'block' }}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
          />
          <p style={{ ...hintStyle(colors), marginTop: 8 }}>Code: <strong>{pairing.code}</strong></p>
          <p style={{ ...hintStyle(colors), marginTop: 4, wordBreak: 'break-all' }}>{pairing.url}</p>
          <p style={{ ...hintStyle(colors), marginTop: 4 }}>Expires in {mmss(pairing.expiresAtMs - now)}</p>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => setPairing(null)} style={buttonStyle(colors, false)}>Done</Button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ ...titleStyle(colors), marginBottom: 6 }}>PAIRED PHONES</div>
        {status.notice && <p role="alert" style={{ ...hintStyle(colors), color: '#ffb454', marginTop: 0 }}>{status.notice}</p>}
        {status.sessions.length === 0 ? (
          <p style={{ ...hintStyle(colors), marginTop: 0 }}>No phones paired</p>
        ) : (
          <>
            {status.sessions.map((s: RemoteSessionInfo) => (
              <div key={s.ref} style={rowStyle}>
                <span style={{ ...hintStyle(colors), marginTop: 0 }}>
                  Paired {new Date(s.createdAtMs).toLocaleString()} - last seen {relative(s.lastSeenMs, now)} - expires{' '}
                  {new Date(s.expiresAtMs).toLocaleDateString()} - id {s.ref.slice(0, 6)}
                </span>
                <Button onClick={() => void revoke(() => remote.revokeOne(s.ref))} style={buttonStyle(colors, false)}>REVOKE</Button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => void revoke(() => remote.revokeAll())} style={buttonStyle(colors, false)}>REVOKE ALL PHONES</Button>
            </div>
          </>
        )}
      </div>

      <p style={hintStyle(colors)}>
        Read-only: a phone on your tailnet can see your Claude chat (prompts, replies, agent messages and tool names)
        with obvious secrets masked, and cannot type or control anything. Reachable over Tailscale only. Access turns
        off when Aether restarts, but paired phones stay paired for 30 days or until revoked. Anyone with a code or a
        paired phone can read this - treat it like a password.
      </p>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 };

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function buttonStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function boxStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, padding: 10, borderRadius: 8, border: `1px solid ${colors.chipBorder}`, background: 'rgba(10,32,43,.4)' };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
