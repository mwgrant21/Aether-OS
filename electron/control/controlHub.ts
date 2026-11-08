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
  TERMINAL_SLOTS,
} from '../../src/shared/remote/types';
import type {
  AuthRejectReason,
  ControlIdentity,
  ControlPairResult,
  ControlPairingResult,
  ControlPort,
  ControlScope,
  ControlSocket,
  ControlStatus,
  ListenerPort,
  PromptReadPort,
  LedgerReadPort,
  ViewId,
  ViewReadPort,
  RemoteSessionInfo,
  RemoteUnavailableReason,
  TerminalReadPort,
  TerminalSlotId,
  TerminalWritePort,
  ThreadReadPort,
} from '../../src/shared/remote/types';
import { createDeviceAuth } from '../remote/remoteAuth';
import type { DeviceAuth, RemoteAuthOptions } from '../remote/remoteAuth';
import { createAlertWatcher } from './alertWatcher';
import { createControlGateway } from './controlGateway';
import type { ControlSession } from './controlGateway';
import { createInputRouter } from './inputRouter';

export const CONTROL_REVOKE_UNSAVED_NOTICE = 'Revoke not saved to disk yet';
/** Flip to false only if the on-device check finds titan cannot see the phone's own 100.x as the source address. */
export const PEER_BINDING_ENFORCED = true;
export const AUTO_ENABLE_MAX_RETRIES = 10;
export const AUTO_ENABLE_RETRY_MS = 30000;

export interface ControlSettingsPort {
  read(): boolean;
  /** Persists the flag and returns the READBACK (what is actually stored), never the requested value. */
  persist(on: boolean): boolean;
  /** Phone-typing switch (default ON). Optional so existing ports keep working. */
  readTyping?(): boolean;
  /** Persists the switch and returns the READBACK. */
  persistTyping?(on: boolean): boolean;
  /** Phone-alerts switch (default OFF). Optional so existing ports keep working. */
  readAlerts?(): boolean;
  /** Persists the switch and returns the READBACK. */
  persistAlerts?(on: boolean): boolean;
}

export interface ControlHubDeps {
  listener: ListenerPort;
  store: RemoteAuthOptions['store'];
  /** Store for the alert-only credential (hash, timestamps, peer; never token text). Optional: without it the credential lives in memory only. */
  alertStore?: RemoteAuthOptions['store'];
  settings: ControlSettingsPort;
  /** Read-only terminal port (never the hub itself). retain() is held exactly while control is on. */
  terminals: TerminalReadPort;
  /** Narrow write handle (write only); inputRouter is the single phone-to-pty write site. Distinct from the read-only `terminals`. */
  input: TerminalWritePort;
  /** Read-only Claude transcript thread. Optional: without it thread.attach is a protocol violation. */
  threads?: ThreadReadPort;
  /** Read-only pending permission prompts, forwarded only to thread-attached sockets. */
  prompts?: PromptReadPort;
  /** Read-only Ledger snapshot feed, forwarded to the gateway; only ledger-attached sockets receive ledger.snap. */
  ledger?: LedgerReadPort;
  /** Read-only generic view feeds by id, forwarded to the gateway; the ids present become welcome.views. */
  views?: Partial<Record<ViewId, ViewReadPort>>;
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
  setPhoneTyping(on: boolean): Promise<ControlStatus>;
  setPhoneAlerts(on: boolean): Promise<ControlStatus>;
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
  let alertAuth: DeviceAuth | null = null; // the alert-only credential: issued beside the main token, revoked and flushed with it
  let state: ControlStatus['state'] = 'off';
  let reason: RemoteUnavailableReason | null = null;
  let address: string | null = null;
  let reenable = false;
  let typing = true;
  let alertsOn = false; // the alerts switch (default off)
  let controlOn = false; // true from a successful acquire until teardown begins; the watcher's only "control is on" gate
  let unsaved = false;
  let saveTimer: unknown = null;
  let saveRetries = 0;
  let autoTimer: unknown = null;
  let autoRetries = 0;
  let stopped = false; // set by stop() (quit path): no timer may be scheduled afterwards
  let chain: Promise<unknown> = Promise.resolve();
  let generation = 0; // bumped by teardown(): a confirm opened before a disable or quit can never mint a token
  let confirmPending = false;
  const sessions = new Map<string, ControlSession>();
  const alertSessions = new Map<string, ControlSession>(); // alert-scope sockets: kept apart so status().connected counts main sockets only
  let releaseTerminals: (() => void) | null = null; // non-null exactly while this hub holds a terminals.retain()

  const attachedByRef = new Map<string, readonly TerminalSlotId[]>(); // a ref's entry is deleted when its gateway reports []
  const unionSlots = (): TerminalSlotId[] => {
    const all = new Set<TerminalSlotId>();
    for (const slots of attachedByRef.values()) for (const s of slots) all.add(s);
    return TERMINAL_SLOTS.map(x => x.s).filter(s => all.has(s));
  };

  const router = createInputRouter({ terminals: deps.input, now, log: (m, r) => { log(`${m} ref=${r}`); }, typingEnabled: () => typing });
  const gateway = createControlGateway({
    now,
    setTimeoutFn: deps.setTimeoutFn,
    clearTimeoutFn: deps.clearTimeoutFn,
    terminals: deps.terminals,
    input: router,
    threads: deps.threads,
    prompts: deps.prompts,
    ledger: deps.ledger,
    views: deps.views,
    onAttached: (ref, slots) => {
      const before = unionSlots().join();
      if (slots.length === 0) attachedByRef.delete(ref);
      else attachedByRef.set(ref, slots);
      if (state === 'on' && unionSlots().join() !== before) emit();
    },
    log: (m, r) => { log(`${m} ref=${r}`); },
  });

  // Label-only delivery: the watcher hands over a three-value kind and nothing else. An alert with no connected
  // alert session is dropped (never queued or replayed); only the kind is logged, and only when a socket got it.
  const watcher = deps.threads
    ? createAlertWatcher({
      threads: deps.threads,
      prompts: deps.prompts,
      setTimeoutFn: deps.setTimeoutFn,
      clearTimeoutFn: deps.clearTimeoutFn,
      onAlert: kind => {
        let delivered = 0;
        for (const s of [...alertSessions.values()]) {
          try { if (s.alert(kind)) delivered++; } catch { /* one failing socket must not stop the others */ }
        }
        if (delivered > 0) log(`control: alert sent kind=${kind}`);
      },
    })
    : null;

  // The watcher runs iff control is on, the hub is not stopped, the switch is on and a thread port exists.
  function syncAlerts(): void {
    if (!watcher) return;
    if (controlOn && state === 'on' && !stopped && alertsOn) watcher.start();
    else watcher.stop();
  }

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
      phoneTyping: typing,
      phoneAlerts: alertsOn,
      notice: unsaved ? CONTROL_REVOKE_UNSAVED_NOTICE : null,
      phoneSlots: state === 'on' ? unionSlots() : [],
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
    alertAuth = createDeviceAuth({
      store: deps.alertStore,
      now: deps.now,
      maxSessions: CONTROL_MAX_DEVICES,
      peerBinding: PEER_BINDING_ENFORCED,
    });
    reenable = deps.settings.read() === true;
    typing = deps.settings.readTyping ? deps.settings.readTyping() !== false : true;
    alertsOn = deps.settings.readAlerts ? deps.settings.readAlerts() === true : false;
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
    const [mainOk, alertOk] = await Promise.all([auth!.flush(), alertAuth!.flush()]);
    const ok = mainOk && alertOk;
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
    const open = [...sessions.values(), ...alertSessions.values()];
    sessions.clear();
    alertSessions.clear();
    for (const s of open) {
      try { s.close(reasonText); } catch { /* one socket that fails to close must not keep the others, or the teardown, from finishing */ }
    }
  }

  // A revoke (or a pairing that replaces the device) must stop typed input at once, not when the ws close event
  // arrives: between ws.close() and that event the gateway would still route `in` frames to the router. So the hub
  // closes the gateway session of every ref that is no longer a paired device, before the listener recheck.
  function dropRevokedSessions(): void {
    const drop = (map: Map<string, ControlSession>, a: DeviceAuth | null): void => {
      const live = new Set((a?.list() ?? []).map(d => d.ref));
      for (const [ref, s] of [...map]) {
        if (live.has(ref)) continue;
        map.delete(ref);
        try { s.close('revoked'); } catch { /* the listener recheck still closes the socket */ }
      }
    };
    drop(sessions, auth);
    drop(alertSessions, alertAuth);
  }

  // Drops the terminals retain exactly once per acquisition: the slot is cleared before the call, so a throwing
  // release or a second teardown (disable then stop) can never release twice.
  function dropTerminals(): void {
    const release = releaseTerminals;
    releaseTerminals = null;
    try { release?.(); } catch { /* releasing is best effort; the hub no longer holds it */ }
  }

  async function teardown(): Promise<void> {
    generation++;
    controlOn = false; // cleared before anything else: the alert watcher must be down before sockets close and the listener goes
    syncAlerts();
    cancelAuto();
    clearSaveTimer();
    auth?.clearPairing(); // a pairing code never outlives the listener it was issued for
    try { deps.listener.closeControlClients('disabled'); } catch { /* closing is best effort */ }
    try {
      closeSessions('disabled');
    } finally {
      dropTerminals(); // privacy section 17: the retain never outlives a disable, whatever closing the sockets did
    }
    try { await deps.listener.release(); } catch { /* already down */ }
    address = null;
  }

  // Acquires the shared listener. Returns the failure reason, or null on success. Never touches the persisted flag.
  async function acquire(): Promise<RemoteUnavailableReason | null> {
    init();
    if (stopped) {
      state = 'unavailable';
      reason = 'error';
      return 'error';
    }
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
    if (releaseTerminals === null) {
      try { releaseTerminals = deps.terminals.retain(); } catch { log('control: terminals unavailable'); }
    }
    controlOn = true;
    syncAlerts();
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

  async function revoke(line: string, fn: () => void): Promise<ControlStatus> {
    init();
    fn();
    log(line);
    dropRevokedSessions();
    deps.listener.recheckControl();
    await settle(true);
    emit();
    return status();
  }

  function peerOf(ref: string, scope: ControlScope | undefined): string | null {
    const d: RemoteSessionInfo | undefined = (scope === 'alert' ? alertAuth : auth)?.list().find(x => x.ref === ref);
    return d?.peer ?? null;
  }

  async function redeem(code: unknown, peer: string | undefined): Promise<ControlPairResult> {
    init();
    if (state !== 'on' || stopped) return { status: 401 };
    if (confirmPending) return { status: 409 }; // 409 busy (429 means burned): one dialog at a time keeps the REPLACES wording truthful
    const replaces = auth!.list().length > 0;
    const opened = generation;
    const approve = (): Promise<boolean> => new Promise<boolean>(resolve => {
      confirmPending = true;
      let settled = false; // per dialog: a late answer from a timed-out dialog must not clear a newer dialog's flag
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        confirmPending = false;
        // a disable or quit while the dialog was open voids the answer
        resolve(ok && opened === generation && state === 'on' && !stopped);
      };
      const timer = setT(() => done(false), CONTROL_PAIR_CONFIRM_TIMEOUT_MS);
      let asked: Promise<boolean>;
      try {
        asked = deps.confirmPair(peer ?? null, replaces);
      } catch {
        clearT(timer);
        done(false);
        return;
      }
      asked.then(
        ok => { clearT(timer); done(ok === true); },
        () => { clearT(timer); done(false); },
      );
    });
    const r = await auth!.redeemDevice(code, peer, approve);
    if (!r.ok) return { status: r.status };
    if (opened !== generation || state !== 'on' || stopped) {
      // a disable or quit landed between the approval and the mint: nothing may stay paired (cap 1, so this is the one device)
      auth!.revokeAll();
      alertAuth!.revokeAll();
      log('control: revoke after-approval-race');
      dropRevokedSessions();
      deps.listener.recheckControl();
      await settle(false);
      emit();
      return { status: 403 };
    }
    const alert = alertAuth!.issue(peer); // the cap of 1 replaces the previous phone's alert token
    log('control: paired');
    dropRevokedSessions();
    deps.listener.recheckControl(); // a superseded device's live sockets stop authenticating
    await settle(true);
    emit();
    return alert
      ? { status: 200, token: r.token, expiresAtMs: r.expiresAtMs, alertToken: alert.token, alertExpiresAtMs: alert.expiresAtMs }
      : { status: 200, token: r.token, expiresAtMs: r.expiresAtMs };
  }

  function open(socket: ControlSocket, identity: ControlIdentity): void {
    const map = identity.scope === 'alert' ? alertSessions : sessions;
    const older = map.get(identity.ref);
    if (older) {
      map.delete(identity.ref);
      older.close('superseded');
    }
    const session = gateway.attach(socket, identity);
    map.set(identity.ref, session);
    log(`control: connect ref=${identity.ref} peer=${peerOf(identity.ref, identity.scope) ?? 'unknown'}`);
    socket.onClose(() => {
      if (map.get(identity.ref) === session) map.delete(identity.ref);
      log(`control: disconnect ref=${identity.ref}`);
      emit();
    });
    emit();
  }

  const port: ControlPort = {
    maxSockets: CONTROL_MAX_SOCKETS,
    authenticate: (authorization, peer, o) => {
      init();
      let mainReason: AuthRejectReason | null = null;
      const viaMain = auth!.authenticate(authorization, peer, { touch: o?.touch, onReject: r => { mainReason = r; } });
      if (viaMain) return { ...viaMain, scope: 'main' };
      let alertReason: AuthRejectReason | null = null;
      const viaAlert = alertAuth!.authenticate(authorization, peer, { touch: o?.touch, onReject: r => { alertReason = r; } });
      if (viaAlert) return { ...viaAlert, scope: 'alert' };
      const why = mainReason === 'unknown' ? (alertReason ?? mainReason) : (mainReason ?? alertReason);
      if (why) {
        try { o?.onReject?.(why); } catch { /* a diagnostic hook never changes the result */ }
      }
      return null;
    },
    pair: redeem,
    open,
  };

  return {
    init,
    status,
    port,
    async setEnabled(on) {
      try {
        await queue(on ? enable : disable);
      } finally {
        emit(); // a disable that throws after state = 'off' must still reach onStatus, which clears the phone view caches
      }
      return status();
    },
    async setReenableAtLaunch(on) {
      init();
      if (state !== 'on') return status();
      reenable = deps.settings.persist(on) === true; // report the readback, never the requested value
      emit();
      return status();
    },
    async setPhoneTyping(on) {
      init();
      typing = deps.settings.persistTyping ? deps.settings.persistTyping(on) !== false : on; // report the readback, never the requested value
      emit();
      return status();
    },
    async setPhoneAlerts(on) {
      init();
      alertsOn = deps.settings.persistAlerts ? deps.settings.persistAlerts(on) === true : on; // report the readback, never the requested value
      syncAlerts();
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
    revokeAll: () => revoke('control: revoke all', () => { auth!.revokeAll(); alertAuth!.revokeAll(); }),
    revokeOne: ref => revoke(`control: revoke one ref=${ref}`, () => { if (auth!.revokeOne(ref)) alertAuth!.revokeAll(); }), // the alert credential belongs to the one paired phone
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
        syncAlerts();
        await Promise.all([auth!.flush(), alertAuth!.flush()]); // no settings write here: the flag survives a quit
      });
    },
  };
}
