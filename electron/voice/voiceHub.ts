// Owns enable/disable, pairing, revocation and status for the voice gateway (privacy §18), composing
// auth, session store, tailnet guard, server, connections, gateway and the one Claude session. The only
// bind host is findTailnetAddress(); there is no fallback address. Status and log lines never carry a
// code, cookie, token, full hash, path or text; the pairing code appears only in createPairing()'s result.
// The Claude child is spawned lazily on the first attached connection, never at enable.
import os from 'node:os';
import {
  VOICE_MAX_SESSIONS,
  VOICE_PORT,
  VOICE_SESSION_TTL_MS,
  type VoicePairingResult,
  type VoiceSessionState,
  type VoiceStatus,
  type VoiceUnavailableReason,
} from '../../src/shared/voice/types';
import { renderQrSvg } from '../remote/pairingQr';
import { createRemoteAuth, type RemoteAuth } from '../remote/remoteAuth';
import { findTailnetAddress } from '../remote/tailnet';
import type { SessionStorePort } from '../remote/types';
import type { VoiceGatewayCore, VoiceGatewayPort } from './protocol';
import { createVoiceConnections } from './voiceConnection';
import { createVoiceGateway } from './voiceGateway';
import { createVoiceSession, type VoiceSession } from './voiceSession';
import { startVoiceServer, type VoiceServerHandle } from './voiceServer';

export const VOICE_REVOKE_UNSAVED_NOTICE = 'Revoke not saved to disk yet';

export interface VoiceHubDeps {
  store: SessionStorePort;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  port?: number;
  startServer?: typeof startVoiceServer;
  createSession?: typeof createVoiceSession;
  createGateway?: typeof createVoiceGateway;
  now?: () => number;
  log?: (line: string) => void;
  onStatus?: (s: VoiceStatus) => void;
  model?: 'sonnet' | 'haiku' | 'opus';
  /** Delay between durability retries after a failed revoke save. */
  retryMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: any) => void;
}

export interface VoiceHub {
  init(): void;
  status(): VoiceStatus;
  setEnabled(on: boolean): Promise<VoiceStatus>;
  createPairing(): Promise<VoicePairingResult>;
  revokeAll(): Promise<VoiceStatus>;
  revokeOne(ref: string): Promise<VoiceStatus>;
  stop(): Promise<void>;
}

const MAX_RETRIES = 3;

export function createVoiceHub(deps: VoiceHubDeps): VoiceHub {
  const log = deps.log ?? (() => {});
  const startServer = deps.startServer ?? startVoiceServer;
  const makeSession = deps.createSession ?? createVoiceSession;
  const makeGateway = deps.createGateway ?? createVoiceGateway;
  const ifaces = deps.networkInterfaces ?? (() => os.networkInterfaces());
  const port = deps.port ?? VOICE_PORT;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let auth: RemoteAuth | null = null;
  let state: VoiceStatus['state'] = 'off';
  let reason: VoiceUnavailableReason | null = null;
  let server: VoiceServerHandle | null = null;
  let session: VoiceSession | null = null;
  let gateway: (VoiceGatewayCore & { start(): void }) | null = null;
  let conns: ReturnType<typeof createVoiceConnections> | null = null;
  let unsubSession: (() => void) | null = null;
  let clientCount = 0;
  let unsaved = false;
  let retryTimer: unknown = null;
  let retries = 0;
  let stopped = false; // set by stop() (quit path): no retry timer may be scheduled afterwards
  // Serialises enable/disable so two quick toggles cannot interleave.
  let chain: Promise<unknown> = Promise.resolve();

  function status(): VoiceStatus {
    const counts = auth?.counts() ?? { sessions: 0, pairingActive: false };
    const on = state === 'on';
    return {
      state,
      reason: state === 'unavailable' ? reason : null,
      address: on && server ? server.address : null,
      connected: on && clientCount > 0,
      session: on && gateway ? (gateway.state() as VoiceSessionState) : 'none',
      sessions: auth ? auth.list() : [],
      pairingActive: counts.pairingActive,
      notice: unsaved ? VOICE_REVOKE_UNSAVED_NOTICE : null,
    };
  }

  function emit(): void {
    if (!deps.onStatus) return;
    try { deps.onStatus(status()); } catch { /* a listener never breaks the hub */ }
  }

  function init(): void {
    if (auth) return;
    auth = createRemoteAuth({
      store: deps.store,
      now: deps.now,
      ttlMs: VOICE_SESSION_TTL_MS,
      maxSessions: VOICE_MAX_SESSIONS,
      onChange: emit,
    });
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearT(retryTimer);
    retryTimer = null;
  }

  // Flushes the store; a false result keeps the notice up and schedules a bounded retry.
  async function settle(allowRetry: boolean): Promise<void> {
    const ok = await auth!.flush();
    if (ok) {
      clearRetry();
      retries = 0;
      unsaved = false;
      return;
    }
    if (!unsaved) log('voice: session store save failed');
    unsaved = true;
    if (allowRetry && !stopped && retryTimer === null && retries < MAX_RETRIES) {
      retries++;
      retryTimer = setT(() => {
        retryTimer = null;
        void settle(true).then(emit);
      }, deps.retryMs ?? 5000);
    }
  }

  // Closes clients, stops the server, then the gateway (which stops the child and clears the event log).
  async function teardown(): Promise<void> {
    clearRetry();
    auth?.clearPairing(); // a pairing code never outlives the listener it was issued for
    const s = server;
    const g = gateway;
    const c = conns;
    const unsub = unsubSession;
    server = null;
    gateway = null;
    conns = null;
    session = null;
    unsubSession = null;
    clientCount = 0;
    if (unsub) { try { unsub(); } catch { /* best effort */ } }
    if (s) {
      try { s.closeClients('disabled'); } catch { /* closing is best effort */ }
    }
    if (c) {
      try { c.closeAll('disabled'); } catch { /* closing is best effort */ }
    }
    if (s) {
      try { await s.stop(); } catch { /* already down */ }
    }
    if (g) {
      try { await g.stop(); } catch { /* the child is best-effort stopped */ }
    }
  }

  function mapReason(e: unknown): VoiceUnavailableReason {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'NO_TAILNET') return 'no-tailnet-address';
    return code === 'EADDRINUSE' ? 'port-in-use' : 'error';
  }

  async function enable(): Promise<void> {
    init();
    if (state === 'on') return;
    if (unsaved) await settle(true); // retry a pending revoke save before opening the listener
    try {
      const address = findTailnetAddress(ifaces() as any);
      if (!address) {
        const e = new Error('no tailnet address') as NodeJS.ErrnoException;
        e.code = 'NO_TAILNET';
        throw e;
      }
      const sess = makeSession({ model: deps.model ?? 'sonnet', log });
      session = sess;
      const gw = makeGateway({ session: sess, log });
      gateway = gw;
      // The gateway subscribes to session events first; session.start() runs only on the first attach,
      // otherwise its synchronous initial `starting` event would be lost.
      gw.start();
      unsubSession = sess.on(() => emit());
      const cn = createVoiceConnections({ gateway: gw, log });
      conns = cn;
      let started = false;
      const port2: VoiceGatewayPort = {
        attach(socket, identity) {
          const handle = cn.attach(socket, identity);
          if (!started) {
            started = true;
            sess.start();
          }
          return handle;
        },
      };
      const s = await startServer({
        host: address,
        port,
        auth: auth!,
        gateway: port2,
        onClients: (n) => { clientCount = n; emit(); },
        log,
      });
      server = s;
      state = 'on';
      reason = null;
      log(`voice: enabled address=${s.address}`);
    } catch (e) {
      await teardown();
      state = 'unavailable';
      reason = mapReason(e);
      if (reason === 'no-tailnet-address') log('voice: no tailnet address');
      else log(reason === 'port-in-use' ? 'voice: port in use' : 'voice: start failed');
    }
  }

  async function disable(): Promise<void> {
    init();
    const was = state;
    await teardown();
    state = 'off';
    reason = null;
    await settle(false); // one final save attempt; disabling leaves no retry timer behind
    if (was === 'on') log('voice: disabled');
  }

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function revoke(fn: () => void): Promise<VoiceStatus> {
    init();
    fn();
    server?.recheckAuth();
    await settle(true);
    emit();
    return status();
  }

  return {
    init,
    status,
    async setEnabled(on) {
      await queue(on ? enable : disable);
      emit();
      return status();
    },
    async createPairing() {
      init();
      if (state !== 'on' || !server) return { ok: false, reason: 'not-enabled' };
      const { code, expiresAtMs } = auth!.createPairing();
      const address = server.address;
      return { ok: true, code, address, qrSvg: renderQrSvg(`aether-voice://${address}/?c=${code}`), expiresAtMs };
    },
    revokeAll: () => revoke(() => auth!.revokeAll()),
    revokeOne: (ref) => revoke(() => { auth!.revokeOne(ref); }),
    async stop() {
      stopped = true;
      await queue(disable);
    },
  };
}
