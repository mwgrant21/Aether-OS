import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { RemoteSessionInfo } from '../../shared/remote/types';
import type { VoicePairingResult, VoiceStatus } from '../../shared/voice/types';

type Pairing = Extract<VoicePairingResult, { ok: true }>;

export function voiceStatusLine(s: VoiceStatus): string {
  if (s.state === 'off') return 'off';
  if (s.state === 'on') {
    // 'none' is idle: the Claude child is spawned lazily at the first authenticated attach.
    const session = s.session === 'none' ? 'idle (starts when a phone connects)' : s.session;
    return `on - ${s.address ?? 'address unknown'} - phone ${s.connected ? 'connected' : 'not connected'} - session ${session}`;
  }
  if (s.reason === 'no-tailnet-address') return 'unavailable: Tailscale address not found';
  if (s.reason === 'port-in-use') return 'unavailable: port in use';
  return 'unavailable: error';
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function VoiceGatewayCard() {
  const colors = useColors();
  const voice = window.aetherElectron?.voice;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pairPending, setPairPending] = useState(false);
  // Bumped by every push so a slower action readback never overwrites newer state.
  const pushSeq = useRef(0);
  const onRef = useRef(false);

  useEffect(() => {
    if (!voice) return;
    let live = true;
    void voice.status().then(s => { if (live && pushSeq.current === 0) setStatus(s); }).catch(() => {});
    const unsubscribe = voice.onStatus(s => { pushSeq.current += 1; if (live) setStatus(s); });
    return () => { live = false; unsubscribe(); };
  }, [voice]);

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

  // Turning the gateway off (or it becoming unavailable) invalidates any displayed code.
  const stateNow = status?.state;
  useEffect(() => {
    onRef.current = stateNow === 'on';
    if (stateNow && stateNow !== 'on') setPairing(null);
  }, [stateNow]);

  if (!voice || !status) {
    return (
      <div style={cardStyle(colors)}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>VOICE GATEWAY (CLAUDE ON THIS PC)</h2>
        <p style={hintStyle(colors)}>{voice ? 'Checking voice gateway...' : 'Available in the desktop app'}</p>
      </div>
    );
  }

  // Show what the main process returned, never the requested value, unless a newer push landed meanwhile.
  const adopt = (s: VoiceStatus, seq: number) => { if (pushSeq.current === seq) setStatus(s); };
  const toggle = async () => {
    setMessage(null);
    const seq = pushSeq.current;
    try {
      adopt(await voice.setEnabled(status.state === 'off'), seq);
    } catch {
      setMessage('Could not change the voice gateway.');
    }
  };
  const pair = async () => {
    if (pairPending) return;
    setMessage(null);
    setPairPending(true);
    try {
      const r = await voice.createPairing();
      // A code that resolves after the gateway left 'on' is dropped, not shown.
      if (r.ok) {
        if (onRef.current) setPairing(r);
      } else setMessage('Turn the voice gateway on first.');
    } catch {
      setMessage('Could not create a pairing code.');
    } finally {
      setPairPending(false);
    }
  };
  const revoke = async (act: () => Promise<VoiceStatus>) => {
    const seq = pushSeq.current;
    try {
      adopt(await act(), seq);
    } catch {
      setMessage('Could not revoke.');
    }
  };

  const on = status.state === 'on';
  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>VOICE GATEWAY (CLAUDE ON THIS PC)</h2>
        <Button onClick={() => void toggle()} style={buttonStyle(colors, on)}>
          {status.state === 'off' ? 'ENABLE' : 'DISABLE'}
        </Button>
      </div>
      <p style={hintStyle(colors)} data-testid="voice-status-line">{voiceStatusLine(status)}</p>
      {message && <p role="alert" style={hintStyle(colors)}>{message}</p>}

      {on && (
        <div style={{ marginTop: 10 }}>
          <Button onClick={() => void pair()} disabled={pairPending} style={buttonStyle(colors, false)}>PAIR A PHONE</Button>
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
          <p style={{ ...hintStyle(colors), marginTop: 4 }}>Expires in {mmss(pairing.expiresAtMs - now)}</p>
          <p style={{ ...hintStyle(colors), marginTop: 4 }}>
            Done only hides this code. It still works until it is used once, replaced by a new code, the gateway is turned off, too many wrong codes are tried, or it expires (see the countdown).
          </p>
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
                  Paired {new Date(s.createdAtMs).toLocaleString()} - expires {new Date(s.expiresAtMs).toLocaleDateString()} - id {s.ref.slice(0, 6)}
                </span>
                <Button onClick={() => void revoke(() => voice.revokeOne(s.ref))} style={buttonStyle(colors, false)}>REVOKE</Button>
              </div>
            ))}
          </>
        )}
        <div style={{ marginTop: 8 }}>
          <Button onClick={() => void revoke(() => voice.revokeAll())} style={buttonStyle(colors, false)}>REVOKE ALL PHONES</Button>
        </div>
      </div>

      <p style={hintStyle(colors)}>
        A paired phone speaks to a Claude session running on this PC. Permission requests need a tap on the phone.
        Masking of obvious secrets is pattern-based, not perfect. Reachable over Tailscale only. Access turns off when
        Aether restarts, but paired phones stay paired for 30 days or until revoked. Treat a pairing code or a paired
        phone like a password.
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
