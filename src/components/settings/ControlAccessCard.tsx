import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useControlStatus } from '../control/useControlStatus';
import type { ControlPairingResult, ControlStatus, RemoteSessionInfo } from '../../shared/remote/types';

type Pairing = Extract<ControlPairingResult, { ok: true }>;

export function controlStatusLine(s: ControlStatus): string {
  if (s.state === 'off') return 'off';
  if (s.state === 'on') {
    return `on - ${s.address ?? 'address unknown'} - ${s.connected} app${s.connected === 1 ? '' : 's'} connected`;
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

export function ControlAccessCard() {
  const colors = useColors();
  const hookStatus = useControlStatus();
  // A readback returned by an action, valid only until the next push replaces the hook's status.
  const [local, setLocal] = useState<{ base: ControlStatus | null; status: ControlStatus } | null>(null);
  const status = local && local.base === hookStatus ? local.status : hookStatus;
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // True while a createPairing call is in flight: a second call could resolve first and leave the older code showing.
  const [pairingBusy, setPairingBusy] = useState(false);

  const control = window.aetherElectron?.control;
  const adopt = (s: ControlStatus) => setLocal({ base: hookStatus, status: s });

  // Latest state, so a createPairing that resolves after the state left 'on' can be dropped.
  const stateNow = status?.state;
  const stateRef = useRef(stateNow);
  stateRef.current = stateNow;
  // Bumped on every state change, so a createPairing issued before an off/on cycle is stale.
  const gen = useRef(0);

  const hasDevices = (status?.devices.length ?? 0) > 0;
  // One tick drives the countdown, the expiry drop and the live "last seen" text.
  useEffect(() => {
    if (!pairing && !hasDevices) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (pairing && t >= pairing.expiresAtMs) setPairing(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairing, hasDevices]);

  // Turning control off (or it becoming unavailable) invalidates any displayed code.
  useEffect(() => {
    gen.current += 1;
    if (stateNow && stateNow !== 'on') setPairing(null);
  }, [stateNow]);

  if (!control || !status) {
    return (
      <div style={cardStyle(colors)}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>PHONE CONTROL (TYPING + APPROVALS)</h2>
        <p style={hintStyle(colors)}>{control ? 'Checking phone control...' : 'Available in the desktop app'}</p>
      </div>
    );
  }

  const toggle = async () => {
    setMessage(null);
    try {
      adopt(await control.setEnabled(status.state === 'off'));
    } catch {
      setMessage('Could not change phone control.');
    }
  };
  const setReenable = async (value: boolean) => {
    setMessage(null);
    try {
      adopt(await control.setReenableAtLaunch(value));
    } catch {
      setMessage('Could not change the launch setting.');
    }
  };
  const pair = async () => {
    setMessage(null);
    setPairingBusy(true);
    try {
      const g = gen.current;
      const r = await control.createPairing();
      if (g !== gen.current || stateRef.current !== 'on') return;
      if (r.ok) setPairing(r);
      else setMessage("Couldn't create a pairing code.");
    } catch {
      setMessage('Could not create a pairing code.');
    } finally {
      setPairingBusy(false);
    }
  };
  const revoke = async (act: () => Promise<ControlStatus>) => {
    try {
      adopt(await act());
    } catch {
      setMessage('Could not revoke.');
    }
  };

  const on = status.state === 'on';
  const replaces = status.devices.length > 0;
  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>PHONE CONTROL (TYPING + APPROVALS)</h2>
        <Button onClick={() => void toggle()} style={buttonStyle(colors, on)}>
          {status.state === 'off' ? 'ENABLE' : 'DISABLE'}
        </Button>
      </div>
      <p style={hintStyle(colors)} data-testid="control-status-line">{controlStatusLine(status)}</p>
      <p style={hintStyle(colors)}>
        A connected, unlocked phone is equivalent to your keyboard on this PC. Treat it like a password.
      </p>
      {message && <p role="alert" style={hintStyle(colors)}>{message}</p>}

      {on && (
        <label style={{ ...hintStyle(colors), display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={status.reenableAtLaunch}
            onChange={e => void setReenable(e.target.checked)}
          />
          RE-ENABLE AT LAUNCH
        </label>
      )}
      {on && (
        <p style={{ ...hintStyle(colors), marginTop: 4 }}>
          When checked, phone control turns itself back on the next time Aether starts. Disabling phone control clears this setting.
        </p>
      )}

      {on && (
        <div style={{ marginTop: 10 }}>
          <Button onClick={() => void pair()} disabled={pairingBusy} style={buttonStyle(colors, false)}>PAIR AN APP</Button>
          {replaces && (
            <p style={hintStyle(colors)}>Pairing a new phone REPLACES the currently paired one.</p>
          )}
        </div>
      )}
      {on && pairing && (
        <div style={boxStyle(colors)}>
          <img
            alt="Pairing QR code"
            width={160}
            height={160}
            style={{ background: '#fff', display: 'block' }}
            src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
          />
          <p style={{ ...hintStyle(colors), marginTop: 8 }}>Code: <strong>{pairing.code}</strong></p>
          <p style={{ ...hintStyle(colors), marginTop: 4 }}>Expires in {mmss(pairing.expiresAtMs - now)}</p>
          <p style={{ ...hintStyle(colors), marginTop: 4 }}>
            You will be asked to confirm on this PC when the app scans it.
            {replaces ? ' Confirming REPLACES the currently paired phone.' : ''}
          </p>
          <div style={{ marginTop: 8 }}>
            <Button onClick={() => setPairing(null)} style={buttonStyle(colors, false)}>Done</Button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={{ ...titleStyle(colors), marginBottom: 6 }}>PAIRED APPS</div>
        {status.notice && (
          <p role="alert" style={{ ...hintStyle(colors), color: colors.danger, marginTop: 0 }}>{status.notice}</p>
        )}
        {status.devices.length === 0 ? (
          <p style={{ ...hintStyle(colors), marginTop: 0 }}>No apps paired</p>
        ) : (
          <>
            {status.devices.map((s: RemoteSessionInfo) => (
              <div key={s.ref} style={rowStyle}>
                <span style={{ ...hintStyle(colors), marginTop: 0 }}>
                  id {s.ref.slice(0, 6)} - paired {new Date(s.createdAtMs).toLocaleString()} - last seen {relative(s.lastSeenMs, now)}
                  {s.peer ? ` - ${s.peer}` : ''} - {Math.max(0, Math.ceil((s.expiresAtMs - now) / 86400_000))} d left
                </span>
                <Button onClick={() => void revoke(() => control.revokeOne(s.ref))} style={buttonStyle(colors, false)}>REVOKE</Button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <Button onClick={() => void revoke(() => control.revokeAll())} style={buttonStyle(colors, false)}>REVOKE ALL APPS</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 };

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.danger}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.danger };
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
