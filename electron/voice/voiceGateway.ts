import { maskSecrets } from '../../src/shared/board/text';
import { VOICE_ORPHAN_TURN_MS, VOICE_PERMISSION_TIMEOUT_MS } from '../../src/shared/voice/types';
import type { VoiceSessionState } from '../../src/shared/voice/types';
import { createEventLog, type ServerEventBody } from './eventLog';
import type { ClientMessage, ServerEvent, VoiceErrorCode, VoiceGatewayCore } from './protocol';
import { createSpeechFilter, type SpeechFilter } from './speechFilter';
import { createPermissionBook, summarizePermission } from './voicePermissions';
import type { SessionEvent, VoiceSession } from './voiceSession';

export type SessionLike = Pick<
  VoiceSession,
  'start' | 'send' | 'interrupt' | 'answerPermission' | 'stop' | 'on' | 'state'
>;

export interface GatewayDeps {
  session: SessionLike;
  log?: (line: string) => void;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
  orphanTurnMs?: number;
  permissionTimeoutMs?: number;
  maxBytes?: number;
}

const SEEN_TURNS = 64;
const SPOKEN_ECHO_CAP = 500;
const TOOL_NAME_CAP = 40;

/** Strip control characters and double quotes, mask, cap: safe to echo and to embed in quotes. */
function sanitizeSpoken(s: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f"]/g, '');
  return maskSecrets(clean).slice(0, SPOKEN_ECHO_CAP); // mask first: a cap must not cut a secret
}

interface Turn {
  id: string;
  filter: SpeechFilter;
  spokenDoneSent: boolean;
  cancelled: boolean;
  spokenText: string;
}

export function createVoiceGateway(deps: GatewayDeps): VoiceGatewayCore & { start(): void } {
  const session = deps.session;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const orphanMs = deps.orphanTurnMs ?? VOICE_ORPHAN_TURN_MS;
  const eventLog = createEventLog({ maxBytes: deps.maxBytes });
  const listeners = new Set<(e: ServerEvent) => void>();
  const seen: string[] = [];

  let turn: Turn | null = null;
  let pending: { id: string; text: string } | null = null;
  let prefix: string | null = null;
  let orphanTimer: unknown = null;
  let unsubSession: (() => void) | null = null;
  let stopped = false;

  const book = createPermissionBook({
    timeoutMs: deps.permissionTimeoutMs ?? VOICE_PERMISSION_TIMEOUT_MS,
    onTimeout: (id) => session.answerPermission(id, false),
    setTimeoutFn: setT,
    clearTimeoutFn: clearT,
  });

  function emit(turnId: string | null, body: ServerEventBody): void {
    const e = eventLog.append(turnId, body);
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        /* a subscriber must not break the gateway */
      }
    }
  }
  function emitError(turnId: string | null, code: VoiceErrorCode, retryable: boolean): void {
    emit(turnId, { t: 'error', code, retryable });
  }
  function clearOrphan(): void {
    if (orphanTimer !== null) {
      clearT(orphanTimer);
      orphanTimer = null;
    }
  }
  function armOrphan(): void {
    if (orphanTimer !== null || !turn || turn.cancelled || listeners.size > 0) return;
    orphanTimer = setT(() => {
      orphanTimer = null;
      if (turn && !turn.cancelled && listeners.size === 0) cancelTurn('');
    }, orphanMs);
  }
  function finish(status: 'completed' | 'interrupted' | 'error' | 'lost'): void {
    const t = turn;
    if (!t) return;
    turn = null;
    clearOrphan();
    if (status === 'error' || status === 'lost') forget(t.id);
    emit(
      t.id,
      status === 'interrupted'
        ? { t: 'turn.completed', status, spokenText: t.spokenText }
        : { t: 'turn.completed', status },
    );
  }
  function cancelTurn(spokenText: string): void {
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    turn.spokenText = sanitizeSpoken(spokenText);
    prefix = turn.spokenText.length > 0 ? turn.spokenText : null;
    clearOrphan();
    session.interrupt();
  }
  function remember(id: string): void {
    seen.push(id);
    if (seen.length > SEEN_TURNS) seen.shift();
  }
  /** A turn the client was told it may retry must not be swallowed as a duplicate. */
  function forget(id: string): void {
    const i = seen.indexOf(id);
    if (i >= 0) seen.splice(i, 1);
  }

  function startTurn(id: string, text: string): void {
    turn = { id, filter: createSpeechFilter(), spokenDoneSent: false, cancelled: false, spokenText: '' };
    emit(id, { t: 'turn.started' });
    const body = prefix !== null ? `[interrupted after: "${prefix}"] ${text}` : text;
    prefix = null;
    if (!session.send(id, body)) {
      finish('error');
      emitError(id, 'turn_failed', true);
      return;
    }
    armOrphan();
  }

  function onStart(msg: Extract<ClientMessage, { t: 'turn.start' }>): void {
    if (seen.includes(msg.turnId)) return;
    if (turn || pending) {
      emitError(msg.turnId, 'busy', true);
      return;
    }
    const st = session.state();
    if (st === 'down') {
      emitError(msg.turnId, 'session_down', false);
    } else if (st === 'restarting') {
      emitError(msg.turnId, 'session_restarting', true);
    } else if (st === 'ready') {
      remember(msg.turnId);
      startTurn(msg.turnId, msg.text);
    } else {
      remember(msg.turnId);
      pending = { id: msg.turnId, text: msg.text };
      emit(null, { t: 'status', kind: 'session', state: 'starting' });
    }
  }

  function flushSpoken(t: Turn, spoken: string[], spokenDone: boolean): void {
    for (const s of spoken) if (s.length > 0) emit(t.id, { t: 'response.delta', text: s });
    if (spokenDone && !t.spokenDoneSent) {
      t.spokenDoneSent = true;
      emit(t.id, { t: 'response.spoken_done' });
    }
  }

  function onSession(e: SessionEvent): void {
    switch (e.k) {
      case 'state': {
        emit(null, { t: 'status', kind: 'session', state: e.state });
        if (e.state !== 'ready') {
          book.closeAll();
          if (turn) finish('lost');
        }
        if (e.state === 'ready' && pending) {
          const p = pending;
          pending = null;
          startTurn(p.id, p.text);
        } else if ((e.state === 'restarting' || e.state === 'down') && pending) {
          const p = pending;
          pending = null;
          forget(p.id);
          emitError(p.id, e.state === 'down' ? 'session_down' : 'session_restarting', e.state !== 'down');
        }
        return;
      }
      case 'delta': {
        if (!turn || turn.id !== e.turnId || turn.cancelled) return;
        const r = turn.filter.push(e.text);
        flushSpoken(turn, r.spoken, r.spokenDone);
        return;
      }
      case 'tool': {
        if (!turn || turn.id !== e.turnId || turn.cancelled) return;
        emit(turn.id, {
          t: 'status',
          kind: e.agent ? 'agent' : 'tool',
          state: maskSecrets(e.name).slice(0, TOOL_NAME_CAP),
        });
        return;
      }
      case 'permission': {
        // The session denies nothing by itself; with nobody to ask, deny right now.
        if (listeners.size === 0) {
          session.answerPermission(e.id, false);
          return;
        }
        book.open(e.id);
        emit(turn ? turn.id : null, {
          t: 'permission.request',
          id: e.id,
          summary: summarizePermission(e.tool, e.input),
        });
        return;
      }
      case 'result': {
        const t = turn;
        if (!t || t.id !== e.turnId) return; // late or duplicate result
        if (t.cancelled || e.interrupted) {
          finish('interrupted');
          return;
        }
        const r = t.filter.end();
        flushSpoken(t, r.spoken, true); // a finished reply is always spoken_done
        if (r.display.length > 0) emit(t.id, { t: 'response.display', text: r.display });
        finish(e.ok ? 'completed' : 'error');
        if (!e.ok) emitError(t.id, 'turn_failed', true);
        return;
      }
      case 'lost': {
        book.closeAll();
        if (!turn || turn.id !== e.turnId) return;
        const id = turn.id;
        finish('error');
        emitError(id, 'session_restarting', true);
        return;
      }
    }
  }

  return {
    start() {
      if (unsubSession || stopped) return;
      unsubSession = session.on(onSession);
    },
    sessionId: () => eventLog.sessionId,
    state: () => session.state() as VoiceSessionState,
    handle(msg) {
      if (stopped) return;
      switch (msg.t) {
        case 'turn.start':
          onStart(msg);
          return;
        case 'turn.cancel':
          if (turn && turn.id === msg.turnId) cancelTurn(msg.spokenText);
          else if (pending && pending.id === msg.turnId) {
            // Queued, never started: drop it and tell the client it was interrupted.
            const id = pending.id;
            pending = null;
            emit(id, { t: 'turn.completed', status: 'interrupted', spokenText: sanitizeSpoken(msg.spokenText) });
          }
          return;
        case 'permission.reply':
          if (book.answer(msg.id)) session.answerPermission(msg.id, msg.approve);
          return;
        default:
          return; // resume belongs to the connection layer
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      clearOrphan();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) armOrphan();
      };
    },
    replayAfter: (n) => eventLog.after(n),
    async stop() {
      stopped = true;
      clearOrphan();
      book.closeAll();
      pending = null;
      turn = null;
      if (unsubSession) {
        unsubSession();
        unsubSession = null;
      }
      listeners.clear();
      await session.stop();
      eventLog.clear();
    },
  };
}
