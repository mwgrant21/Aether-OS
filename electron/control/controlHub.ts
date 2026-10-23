// electron/control/controlHub.ts
//
// Owns enable/disable, the opt-in persisted re-enable flag, pairing, revocation and status for phone control. Every
// dependency (listener, device store, settings file, native confirm, QR renderer, timers) is injected; nothing here
// touches fs, os, crypto or the network. Status and log lines carry no code, token, bearer, hash or full ref: only
// the 12-char ref, the peer address and counts. The pairing code appears only in createPairing()'s result.
//
// Quit vs user disable: setEnabled(false) clears the persisted flag (the user turned control off); stop() never
// touches it (the app is quitting and the user asked for control to come back next launch).
import {
  CONTROL_MAX_DEVICES,
  CONTROL_MAX_SOCKETS,
  CONTROL_PAIR_CONFIRM_TIMEOUT_MS,
} from '../../src/shared/remote/types';
import type {
  ControlIdentity,
  ControlPairResult,
  ControlPairingResult,
  ControlPort,
  ControlSocket,
  ControlStatus,
  ListenerPort,
  RemoteSessionInfo,
  RemoteUnavailableReason,
} from '../../src/shared/remote/types';
import { createDeviceAuth } from '../remote/remoteAuth';
import type { DeviceAuth, RemoteAuthOptions } from '../remote/remoteAuth';
import { createControlGateway } from './controlGateway';
import type { ControlSession } from './controlGateway';

export const CONTROL_REVOKE_UNSAVED_NOTICE = 'Revoke not saved to disk yet';
/** Flip to false only if the on-device check finds titan cannot see the phone's own 100.x as the source address. */
export const PEER_BINDING_ENFORCED = true;
export const AUTO_ENABLE_MAX_RETRIES = 10;
export const AUTO_ENABLE_RETRY_MS = 30000;

export interface ControlSettingsPort {
  read(): boolean;
  /** Persists the flag and returns the READBACK (what is actually stored), never the requested value. */
  persist(on: boolean): boolean;
}

export interface ControlHubDeps {
  listener: ListenerPort;
  store: RemoteAuthOptions['store'];
  settings: ControlSettingsPort;
  /** Native confirm for a pairing redeem. replacesExisting is true when a phone is already paired (it will be replaced). */
  confirmPair(peer: string | null, replacesExisting: boolean): Promise<boolean>;
  renderQr(text: string): string;
  now?: () => number;
  log?: (line: string) => void;
  onStatus?: (s: ControlStatus) => void;
  /** Delay between durability retries after a failed revoke save. */
  retryMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ControlHub {
  init(): void;
  status(): ControlStatus;
  setEnabled(on: boolean): Promise<ControlStatus>;
  setReenableAtLaunch(on: boolean): Promise<ControlStatus>;
  createPairing(): Promise<ControlPairingResult>;
  revokeAll(): Promise<ControlStatus>;
  revokeOne(ref: string): Promise<ControlStatus>;
  retrySave(): Promise<ControlStatus>;
  autoEnable(): Promise<void>;
  stop(): Promise<void>;
  port: ControlPort;
}

const MAX_SAVE_RETRIES = 3;

export function createControlHub(deps: ControlHubDeps): ControlHub {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));

  let auth: DeviceAuth | null = null;
  let state: ControlStatus['state'] = 'off';
  let reason: RemoteUnavailableReason | null = null;
  let address: string | null = null;
  let reenable = false;
  let unsaved = false;
  let saveTimer: unknown = null;
  let saveRetries = 0;
  let autoTimer: unknown = null;
  let autoRetries = 0;
  let stopped = false; // set by stop() (quit path): no timer may be scheduled afterwards
  let chain: Promise<unknown> = Promise.resolve();
  const sessions = new Map<string, ControlSession>();

  const gateway = createControlGateway({
    now,
    setTimeoutFn: deps.setTimeoutFn,
    clearTimeoutFn: deps.clearTimeoutFn,
    log: (m, r) => { log(`control: ${m} ref=${r}`); },
  });

  function status(): ControlStatus {
    const counts = auth?.counts() ?? { sessions: 0, pairingActive: false };
    return {
      state,
      reason: state === 'unavailable' ? reason : null,
      address: state === 'on' ? address : null,
      connected: state === 'on' ? sessions.size : 0,
      devices: auth ? auth.list() : [],
      pairingActive: counts.pairingActive,
      reenableAtLaunch: reenable,
      notice: unsaved ? CONTROL_REVOKE_UNSAVED_NOTICE : null,
    };
  }

  function emit(): void {
    if (!deps.onStatus) return;
    try { deps.onStatus(status()); } catch { /* a listener never breaks the hub */ }
  }

  function init(): void {
    if (auth) return;
    auth = createDeviceAuth({
      store: deps.store,
      now: deps.now,
      onChange: emit,
      maxSessions: CONTROL_MAX_DEVICES,
      peerBinding: PEER_BINDING_ENFORCED,
    });
    reenable = deps.settings.read() === true;
  }

  function clearSaveTimer(): void {
    if (saveTimer !== null) clearT(saveTimer);
    saveTimer = null;
  }

  function cancelAuto(): void {
    if (autoTimer !== null) clearT(autoTimer);
    autoTimer = null;
  }

  // Flushes the store; a false result keeps the notice up and schedules a bounded retry.
  async function settle(allowRetry: boolean): Promise<void> {
    const ok = await auth!.flush();
    if (ok) {
      clearSaveTimer();
      saveRetries = 0;
      unsaved = false;
      return;
    }
    if (!unsaved) log('control: device store save failed');
    unsaved = true;
    if (allowRetry && !stopped && saveTimer === null && saveRetries < MAX_SAVE_RETRIES) {
      saveRetries++;
      saveTimer = setT(() => {
        saveTimer = null;
        void settle(true).then(emit);
      }, deps.retryMs ?? 5000);
    }
  }

  function closeSessions(reasonText: 'revoked' | 'disabled' | 'superseded'): void {
    const open = [...sessions.values()];
    sessions.clear();
    for (const s of open) s.close(reasonText);
  }

  async function teardown(): Promise<void> {
    cancelAuto();
    clearSaveTimer();
    auth?.clearPairing(); // a pairing code never outlives the listener it was issued for
    try { deps.listener.closeControlClients('disabled'); } catch { /* closing is best effort */ }
    closeSessions('disabled');
    try { await deps.listener.release(); } catch { /* already down */ }
    address = null;
  }

  // Acquires the shared listener. Returns the failure reason, or null on success. Never touches the persisted flag.
  async function acquire(): Promise<RemoteUnavailableReason | null> {
    init();
    if (state === 'on') return null;
    if (unsaved) await settle(true); // retry a pending revoke save before opening the listener
    let r: Awaited<ReturnType<ListenerPort['acquire']>>;
    try {
      r = await deps.listener.acquire();
    } catch {
      r = { ok: false, reason: 'error' };
    }
    if (!r.ok) {
      state = 'unavailable';
      reason = r.reason;
      address = null;
      log(`control: listener unavailable reason=${r.reason}`);
      return r.reason;
    }
    state = 'on';
    reason = null;
    address = r.address;
    log('control: enabled');
    return null;
  }

  async function disable(): Promise<void> {
    init();
    const was = state;
    cancelAuto();
    autoRetries = 0;
    await teardown();
    state = 'off';
    reason = null;
    reenable = deps.settings.persist(false) === true; // a user disable clears the opt-in; quit never gets here
    await settle(false); // one final save attempt; disabling leaves no retry timer behind
    if (was === 'on') log('control: disabled');
  }

  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  async function enable(): Promise<void> {
    cancelAuto(); // a manual enable supersedes any pending launch retry
    autoRetries = 0;
    await acquire();
  }

  async function autoAttempt(): Promise<void> {
    if (stopped || state === 'on') return;
    const failure = await acquire();
    emit();
    if (failure === 'no-tailnet-address' && !stopped && autoRetries < AUTO_ENABLE_MAX_RETRIES) {
      autoRetries++;
      autoTimer = setT(() => {
        autoTimer = null;
        void queue(autoAttempt);
      }, AUTO_ENABLE_RETRY_MS);
    }
  }

  async function revoke(fn: () => void): Promise<ControlStatus> {
    init();
    fn();
    deps.listener.recheckControl();
    await settle(true);
    emit();
    return status();
  }

  function peerOf(ref: string): string | null {
    const d: RemoteSessionInfo | undefined = auth?.list().find(x => x.ref === ref);
    return d?.peer ?? null;
  }

  async function redeem(code: unknown, peer: string | undefined): Promise<ControlPairResult> {
    init();
    if (state !== 'on') return { status: 401 };
    const replaces = auth!.list().length > 0;
    const approve = (): Promise<boolean> => new Promise<boolean>(resolve => {
      const timer = setT(() => resolve(false), CONTROL_PAIR_CONFIRM_TIMEOUT_MS);
      deps.confirmPair(peer ?? null, replaces).then(
        ok => { clearT(timer); resolve(ok === true); },
        () => { clearT(timer); resolve(false); },
      );
    });
    const r = await auth!.redeemDevice(code, peer, approve);
    if (!r.ok) return { status: r.status };
    log('control: paired');
    deps.listener.recheckControl(); // a superseded device's live sockets stop authenticating
    await settle(true);
    emit();
    return { status: 200, token: r.token, expiresAtMs: r.expiresAtMs };
  }

  function open(socket: ControlSocket, identity: ControlIdentity): void {
    const older = sessions.get(identity.ref);
    if (older) {
      sessions.delete(identity.ref);
      older.close('superseded');
    }
    const session = gateway.attach(socket, identity);
    sessions.set(identity.ref, session);
    log(`control: connect ref=${identity.ref} peer=${peerOf(identity.ref) ?? 'unknown'}`);
    socket.onClose(() => {
      if (sessions.get(identity.ref) === session) sessions.delete(identity.ref);
      log(`control: disconnect ref=${identity.ref}`);
      emit();
    });
    emit();
  }

  const port: ControlPort = {
    maxSockets: CONTROL_MAX_SOCKETS,
    authenticate: (authorization, peer, o) => {
      init();
      return auth!.authenticate(authorization, peer, o);
    },
    pair: redeem,
    open,
  };

  return {
    init,
    status,
    port,
    async setEnabled(on) {
      await queue(on ? enable : disable);
      emit();
      return status();
    },
    async setReenableAtLaunch(on) {
      init();
      if (state !== 'on') return status();
      reenable = deps.settings.persist(on) === true; // report the readback, never the requested value
      emit();
      return status();
    },
    async createPairing() {
      init();
      if (state !== 'on' || !address) return { ok: false, reason: 'not-enabled' };
      const made = auth!.createPairing();
      const cut = address.lastIndexOf(':');
      const host = address.slice(0, cut);
      const portText = address.slice(cut + 1);
      const uri = `aethermobile://pair?host=${host}&port=${portText}&code=${made.code}`;
      return { ok: true, uri, code: made.code, qrSvg: deps.renderQr(uri), expiresAtMs: made.expiresAtMs };
    },
    revokeAll: () => revoke(() => { auth!.revokeAll(); }),
    revokeOne: ref => revoke(() => { auth!.revokeOne(ref); }),
    async retrySave() {
      init();
      await settle(true);
      emit();
      return status();
    },
    async autoEnable() {
      if (stopped) return;
      init();
      if (deps.settings.read() !== true) return;
      reenable = true;
      autoRetries = 0;
      await queue(autoAttempt);
    },
    async stop() {
      stopped = true;
      cancelAuto();
      clearSaveTimer();
      await queue(async () => {
        init();
        await teardown();
        state = 'off';
        reason = null;
        await auth!.flush(); // no settings write here: the flag survives a quit
      });
    },
  };
}
