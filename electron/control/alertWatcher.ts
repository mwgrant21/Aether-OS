import type { AlertKind, PromptReadPort, ThreadEvent, ThreadReadPort } from '../../src/shared/remote/types';
import { classifyStop } from './alertClassifier';

export const ALERT_DEBOUNCE_MS = 4000;
const SEEN_PROMPTS_MAX = 64;

export interface AlertWatcherDeps {
  threads: ThreadReadPort;
  prompts?: PromptReadPort;
  /** The only output: a three-value label, never content. */
  onAlert(kind: AlertKind): void;
  debounceMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}
export interface AlertWatcher { start(): void; stop(): void; running(): boolean }

/**
 * Edge-triggered stop alerts. A turn going busy -> idle arms a debounce; a busy mark inside the window
 * cancels it, an interrupted idle suppresses it, and `fired` keeps one alert per busy period. Alerts come
 * only from `turn` marks (lines appended while following), never from snap history or `state`. A prompt
 * opened after attach that is still open after the debounce raises one `input`; replayed prompts do not.
 */
export function createAlertWatcher(deps: AlertWatcherDeps): AlertWatcher {
  const debounceMs = deps.debounceMs ?? ALERT_DEBOUNCE_MS;
  const setT = deps.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h: unknown): void => { clearTimeout(h as ReturnType<typeof setTimeout>); });

  let threadHandle: { detach(): void } | null = null;
  let promptHandle: { detach(): void } | null = null;
  let armed: unknown = null;
  let hasArmed = false;
  let fired = false;
  let lastClaudeText: string | null = null;
  let lastTruncated = false;
  let replaying = false;
  let seen = new Set<string>();
  const promptTimers = new Map<string, unknown>();

  const cancelTurnTimer = (): void => {
    if (hasArmed) clearT(armed);
    armed = null;
    hasArmed = false;
  };

  const absorb = (evs: readonly ThreadEvent[]): void => {
    for (const e of evs) {
      if (e.k === 'user') { lastClaudeText = null; lastTruncated = false; }
      else if (e.k === 'claude') { lastClaudeText = e.text; lastTruncated = e.truncated; }
    }
  };

  const remember = (id: string): void => {
    seen.add(id);
    if (seen.size > SEEN_PROMPTS_MAX) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
  };

  const start = (): void => {
    if (threadHandle) return;
    lastClaudeText = null;
    lastTruncated = false;
    fired = false;
    threadHandle = deps.threads.attach('claude', {
      snap(e) { lastClaudeText = null; lastTruncated = false; absorb(e.events); },
      events(e) { absorb(e.events); },
      state() { /* never infers idle from state */ },
      turn(e) {
        if (e.mark === 'busy') { cancelTurnTimer(); fired = false; return; }
        if (e.interrupted) { cancelTurnTimer(); fired = true; return; }
        if (fired || hasArmed) return;
        hasArmed = true;
        armed = setT(() => {
          armed = null;
          hasArmed = false;
          fired = true;
          deps.onAlert(classifyStop(lastClaudeText, lastTruncated));
        }, debounceMs);
      },
    });
    if (deps.prompts) {
      replaying = true;
      try {
        promptHandle = deps.prompts.attach({
          opened(p) {
            if (replaying) { remember(p.id); return; }
            if (seen.has(p.id)) return;
            remember(p.id);
            promptTimers.set(p.id, setT(() => {
              promptTimers.delete(p.id);
              deps.onAlert('input');
            }, debounceMs));
          },
          closed(e) {
            const h = promptTimers.get(e.id);
            if (h !== undefined) { clearT(h); promptTimers.delete(e.id); }
          },
        });
      } finally {
        replaying = false;
      }
    }
  };

  const stop = (): void => {
    if (!threadHandle) return;
    cancelTurnTimer();
    for (const h of promptTimers.values()) clearT(h);
    promptTimers.clear();
    threadHandle.detach();
    threadHandle = null;
    if (promptHandle) { promptHandle.detach(); promptHandle = null; }
    seen = new Set<string>();
    fired = false;
    lastClaudeText = null;
    lastTruncated = false;
  };

  return { start, stop, running: () => threadHandle !== null };
}
