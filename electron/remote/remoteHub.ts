// Owns enable/disable, pairing, revocation and status for phone access, composing the chat feed,
// auth, session store, tailnet guard and server. One listener serves two holders, the viewer
// (setEnabled) and phone control (listenerPort); it is up while either holds it and the viewer's
// status describes the viewer only. The only bind host is findTailnetAddress();
// nothing here reads a configured host. Status and log lines never carry a code, cookie, token,
// full hash, path or message text; the pairing code appears only in createPairing()'s result.
import os from 'node:os';
import {
  REMOTE_PORT,
  type ControlPort,
  type ListenerPort,
  type PairingResult,
  type RemoteStatus,
  type RemoteUnavailableReason,
} from '../../src/shared/remote/types';
import { createChatFeed } from './chatFeed';
import { renderQrSvg } from './pairingQr';
import { createRemoteAuth, type RemoteAuth } from './remoteAuth';
import { REMOTE_ASSETS } from './remotePages';
import { startRemoteServer, type RemoteServerHandle } from './remoteServer';
import { findTailnetAddress } from './tailnet';
import type { ChatFeed, SessionStorePort } from './types';

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
  onStatus?: (s: RemoteStatus) => void;
  /** Delay between durability retries after a failed revoke save. */
  retryMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: any) => void;
}

export interface RemoteHub {
  init(): void;
  status(): RemoteStatus;
  setEnabled(on: boolean): Promise<RemoteStatus>;
  /** Registers the control logic the server hands /ctl to. Call before listenerPort().acquire(). */
  attachControl(port: ControlPort): void;
  /** The control hub's handle on the shared listener. */
  listenerPort(): ListenerPort;
  createPairing(): Promise<PairingResult>;
  revokeAll(): Promise<RemoteStatus>;
  revokeOne(ref: string): Promise<RemoteStatus>;
  /** Retries a pending unsaved revoke so the notice can clear without another revoke. */
  retrySave(): Promise<RemoteStatus>;
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
  let controlOn = false;
  let controlPort: ControlPort | null = null;
  let serverHasControl = false;
  let ctlCb: ((n: number) => void) | null = null;
  // Stable proxy handed to the server: delegates to the live feed, or does nothing while the viewer is off.
  const feedProxy: ChatFeed = {
    join: (l) => (feed ? feed.join(l) : { leave() {} }),
  };
  let unsaved = false;
  let retryTimer: unknown = null;
  let retries = 0;
  let stopped = false; // set by stop() (quit path): no retry timer may be scheduled afterwards
  // Serialises enable/disable so two quick toggles cannot interleave.
  let chain: Promise<unknown> = Promise.resolve();

  function status(): RemoteStatus {
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
    if (allowRetry && !stopped && retryTimer === null && retries < MAX_RETRIES) {
      retries++;
      retryTimer = setT(() => {
        retryTimer = null;
        void settle(true).then(emit);
      }, deps.retryMs ?? 5000);
    }
  }

  async function teardown(): Promise<void> {
    clearRetry();
    auth?.clearPairing(); // a pairing code never outlives the listener it was issued for
    const s = server;
    const f = feed;
    server = null;
    feed = null;
    clientCount = 0;
    if (s) {
      try { s.closeClients('disabled'); } catch { /* closing is best effort */ }
      try { s.closeControlClients('disabled'); } catch { /* closing is best effort */ }
      try { await s.stop(); } catch { /* already down */ }
      ctlCb?.(0);
    }
    if (f) f.stop(); // clears the replay buffer
  }

  // Starts the shared server for whichever holder needs it first. Throws on failure.
  function tailnetAddress(): string {
    const address = findTailnetAddress(ifaces() as any);
    if (!address) {
      const e = new Error('no tailnet address') as NodeJS.ErrnoException;
      e.code = 'NO_TAILNET';
      throw e;
    }
    return address;
  }

  async function startShared(address: string): Promise<RemoteServerHandle> {
    const s = await startServer({
      host: address,
      port,
      auth: auth!,
      feed: feedProxy,
      assets: REMOTE_ASSETS,
      viewerOpen: () => state === 'on',
      controlOpen: () => controlOn,
      control: controlPort ?? undefined,
      onClients: (n) => { clientCount = n; emit(); },
      onControlClients: (n) => { ctlCb?.(n); },
      log,
    });
    server = s;
    serverHasControl = controlPort !== null;
    return s;
  }

  async function enable(): Promise<void> {
    init();
    if (state === 'on') return;
    if (unsaved) await settle(true); // retry a pending revoke save before opening the listener
    let f: ReturnType<typeof createChatFeed> | null = null;
    const started = server === null;
    try {
      const address = server ? '' : tailnetAddress(); // before the feed exists: no tailnet leaves nothing to stop
      f = makeFeed({ resolveSession: deps.resolveSession, log });
      f.start();
      const s = server ?? (await startShared(address));
      feed = f;
      state = 'on';
      reason = null;
      log(`remote: enabled address=${s.address}`);
    } catch (e) {
      if (f) f.stop();
      feed = null;
      if (started && server) { try { await server.stop(); } catch { /* already down */ } server = null; }
      state = 'unavailable';
      reason = mapReason(e);
      if (reason === 'no-tailnet-address') log('remote: no tailnet address');
      else log(reason === 'port-in-use' ? 'remote: port in use' : 'remote: start failed');
    }
  }

  function mapReason(e: unknown): RemoteUnavailableReason {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'NO_TAILNET') return 'no-tailnet-address';
    return code === 'EADDRINUSE' ? 'port-in-use' : 'error';
  }

  async function disable(): Promise<void> {
    init();
    const was = state;
    if (controlOn && server) {
      // Control still holds the listener: drop only the viewer side.
      auth?.clearPairing();
      clientCount = 0;
      try { server.closeClients('disabled'); } catch { /* closing is best effort */ }
      const f = feed;
      feed = null;
      if (f) f.stop(); // clears the replay buffer
    } else {
      clearRetry();
      await teardown();
    }
    state = 'off';
    reason = null;
    await settle(false); // one final save attempt; disabling leaves no retry timer behind
    if (was === 'on') log('remote: disabled');
  }

  async function acquireControl(): Promise<{ ok: true; address: string } | { ok: false; reason: RemoteUnavailableReason }> {
    init();
    if (!controlPort) return { ok: false, reason: 'error' };
    if (server && !serverHasControl) return { ok: false, reason: 'error' };
    try {
      const s = server ?? (await startShared(tailnetAddress()));
      controlOn = true;
      return { ok: true, address: s.address };
    } catch (e) {
      const r = mapReason(e);
      log(r === 'no-tailnet-address' ? 'remote: no tailnet address' : r === 'port-in-use' ? 'remote: port in use' : 'remote: start failed');
      return { ok: false, reason: r };
    }
  }

  async function releaseControl(): Promise<void> {
    if (!controlOn) return;
    controlOn = false;
    if (server) { try { server.closeControlClients('disabled'); } catch { /* best effort */ } }
    if (state === 'on') return; // the viewer still holds the listener
    await teardown();
  }

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function revoke(fn: () => void): Promise<RemoteStatus> {
    init();
    fn();
    server?.recheckAuth();
    await settle(true);
    emit();
    return status();
  }

  const listener: ListenerPort = {
    acquire: () => queue(acquireControl),
    release: () => queue(releaseControl),
    address: () => (server ? server.address : null),
    closeControlClients: (r) => { server?.closeControlClients(r); },
    recheckControl: () => { server?.recheckControl(); },
    onControlClients: (cb) => { ctlCb = cb; },
  };

  return {
    init,
    status,
    attachControl(p) { controlPort = p; },
    listenerPort: () => listener,
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
    async retrySave() {
      init();
      await settle(true);
      emit();
      return status();
    },
    async stop() {
      stopped = true;
      await queue(async () => {
        controlOn = false;
        await disable();
      });
    },
  };
}
