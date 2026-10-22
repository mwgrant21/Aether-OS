// Owns enable/disable, pairing, revocation and status for phone access, composing the chat feed,
// auth, session store, tailnet guard and server. The only bind host is findTailnetAddress();
// nothing here reads a configured host. Status and log lines never carry a code, cookie, token,
// full hash, path or message text; the pairing code appears only in createPairing()'s result.
import os from 'node:os';
import { REMOTE_PORT, type PairingResult, type RemoteStatus, type RemoteUnavailableReason } from '../../src/shared/remote/types';
import { createChatFeed } from './chatFeed';
import { renderQrSvg } from './pairingQr';
import { createRemoteAuth, type RemoteAuth } from './remoteAuth';
import { REMOTE_ASSETS } from './remotePages';
import { startRemoteServer, type RemoteServerHandle } from './remoteServer';
import { findTailnetAddress } from './tailnet';
import type { SessionStorePort } from './types';

/** RemoteStatus plus a fixed notice string while a revoke is not yet durable on disk. */
export type RemoteHubStatus = RemoteStatus & { notice: string | null };

export const REVOKE_UNSAVED_NOTICE = 'Revoke not saved to disk yet';

export interface RemoteHubDeps {
  resolveSession: () => { sessionId: string; file: string } | null;
  store: SessionStorePort;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  port?: number;
  startServer?: typeof startRemoteServer;
  createFeed?: typeof createChatFeed;
  now?: () => number;
  log?: (line: string) => void;
  onStatus?: (s: RemoteHubStatus) => void;
  /** Delay between durability retries after a failed revoke save. */
  retryMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: any) => void;
}

export interface RemoteHub {
  init(): void;
  status(): RemoteHubStatus;
  setEnabled(on: boolean): Promise<RemoteHubStatus>;
  createPairing(): Promise<PairingResult>;
  revokeAll(): Promise<RemoteHubStatus>;
  revokeOne(ref: string): Promise<RemoteHubStatus>;
  stop(): Promise<void>;
}

const MAX_RETRIES = 3;

export function createRemoteHub(deps: RemoteHubDeps): RemoteHub {
  const log = deps.log ?? (() => {});
  const startServer = deps.startServer ?? startRemoteServer;
  const makeFeed = deps.createFeed ?? createChatFeed;
  const ifaces = deps.networkInterfaces ?? (() => os.networkInterfaces());
  const port = deps.port ?? REMOTE_PORT;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let auth: RemoteAuth | null = null;
  let state: RemoteStatus['state'] = 'off';
  let reason: RemoteUnavailableReason | null = null;
  let server: RemoteServerHandle | null = null;
  let feed: ReturnType<typeof createChatFeed> | null = null;
  let clientCount = 0;
  let unsaved = false;
  let retryTimer: unknown = null;
  let retries = 0;
  // Serialises enable/disable so two quick toggles cannot interleave.
  let chain: Promise<unknown> = Promise.resolve();

  function status(): RemoteHubStatus {
    const counts = auth?.counts() ?? { sessions: 0, pairingActive: false };
    return {
      state,
      reason: state === 'unavailable' ? reason : null,
      address: state === 'on' && server ? server.address : null,
      clients: state === 'on' ? clientCount : 0,
      sessions: auth ? auth.list() : [],
      pairingActive: counts.pairingActive,
      following: deps.resolveSession() !== null,
      notice: unsaved ? REVOKE_UNSAVED_NOTICE : null,
    };
  }

  function emit(): void {
    if (!deps.onStatus) return;
    try { deps.onStatus(status()); } catch { /* a listener never breaks the hub */ }
  }

  function init(): void {
    if (auth) return;
    auth = createRemoteAuth({ store: deps.store, now: deps.now, onChange: emit });
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
    if (!unsaved) log('remote: session store save failed');
    unsaved = true;
    if (allowRetry && retryTimer === null && retries < MAX_RETRIES) {
      retries++;
      retryTimer = setT(() => {
        retryTimer = null;
        void settle(true).then(emit);
      }, deps.retryMs ?? 5000);
    }
  }

  async function teardown(): Promise<void> {
    clearRetry();
    const s = server;
    const f = feed;
    server = null;
    feed = null;
    clientCount = 0;
    if (s) {
      try { s.closeClients('disabled'); } catch { /* closing is best effort */ }
      try { await s.stop(); } catch { /* already down */ }
    }
    if (f) f.stop(); // clears the replay buffer
  }

  async function enable(): Promise<void> {
    init();
    if (state === 'on') return;
    const address = findTailnetAddress(ifaces() as any);
    if (!address) {
      state = 'unavailable';
      reason = 'no-tailnet-address';
      log('remote: no tailnet address');
      return;
    }
    const f = makeFeed({ resolveSession: deps.resolveSession, log });
    f.start();
    try {
      const s = await startServer({
        host: address,
        port,
        auth: auth!,
        feed: f,
        assets: REMOTE_ASSETS,
        onClients: (n) => { clientCount = n; emit(); },
        log,
      });
      server = s;
      feed = f;
      state = 'on';
      reason = null;
      log(`remote: enabled address=${s.address}`);
    } catch (e) {
      f.stop();
      state = 'unavailable';
      reason = (e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'port-in-use' : 'error';
      log(reason === 'port-in-use' ? 'remote: port in use' : 'remote: start failed');
    }
  }

  async function disable(): Promise<void> {
    init();
    const was = state;
    await teardown();
    state = 'off';
    reason = null;
    await settle(false); // one final save attempt; disabling leaves no retry timer behind
    if (was === 'on') log('remote: disabled');
  }

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function revoke(fn: () => void): Promise<RemoteHubStatus> {
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
      const url = `http://${server.address}/pair#c=${code}`;
      return { ok: true, url, code, qrSvg: renderQrSvg(url), expiresAtMs };
    },
    revokeAll: () => revoke(() => auth!.revokeAll()),
    revokeOne: (ref) => revoke(() => { auth!.revokeOne(ref); }),
    async stop() {
      await queue(disable);
    },
  };
}
