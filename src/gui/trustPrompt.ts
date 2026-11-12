export interface ScreenBufferLike {
  viewportY: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/** Viewport rows [0, rows) joined with '\n'. An undefined buffer (terminal not mounted) reads as ''. */
export function readScreenText(buf: ScreenBufferLike | undefined, rows: number): string {
  if (!buf) return '';
  const out: string[] = [];
  for (let y = 0; y < rows; y++) out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  return out.join('\n');
}

const NEEDLES = ['quicksafetycheck', 'itrustthisfolder', 'accessingworkspace', 'noexit'];

/**
 * True when the text looks like Claude's folder-trust prompt: at least TWO of four needles
 * ("quick safety check", "I trust this folder", "accessing workspace", the option line "No, exit")
 * after lowercasing and stripping everything but letters and digits (immune to row wraps, spacing, punctuation such as the comma in "No, exit", and chunk splits).
 * Two-of-four tolerates one phrase being reworded or scrolled off a short pane, while a lone phrase
 * in ordinary chat output does not hold the composer. The footer "Enter to confirm" is deliberately
 * not a needle (generic to other Claude dialogs).
 *
 * Safety argument: a false negative equals today's behaviour (composer enabled, Enter answers the
 * prompt). That is safe in claude 2.1.322 only because the default option there is "No, exit", so a
 * stray Enter exits Claude and trust is not granted; a version defaulting to "Yes" would grant trust
 * and no secondary signal exists. A false positive only disables the composer while that text is on
 * screen, and typing in the pane recovers.
 *
 * UNVERIFIED: (1) after "Yes", Claude must erase the dialog for the screen check to clear; (2) a
 * renderer reload mid-prompt starts a blank pane (no mirror), so the prompt is not seen; (3) needles
 * are English only; (4) other Claude versions' wording and default option.
 */
export function isTrustPromptText(text: string): boolean {
  const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return NEEDLES.filter((n) => flat.includes(n)).length >= 2;
}

export const TRUST_DETECT_MS = 250;
export const TRUST_CLEAR_MS = 1500;

export interface TrustWatcher {
  feed(): void;
  reset(): void;
  dispose(): void;
}

/**
 * Detection is a throttle: while no prompt is shown a pending read timer is kept (reading the screen
 * is idempotent), so a spinner emitting chunks faster than detectMs cannot starve it. Clearing is a
 * debounce: while shown, every chunk re-arms clearMs so the composer returns only after the screen
 * is clear AND quiet. onChange fires only on a state change; the timer never re-arms itself.
 */
export function createTrustWatcher(o: {
  schedule: (fn: () => void, ms: number) => () => void;
  readScreen: () => string;
  onChange: (shown: boolean) => void;
  detectMs?: number;
  clearMs?: number;
}): TrustWatcher {
  const detectMs = o.detectMs ?? TRUST_DETECT_MS;
  const clearMs = o.clearMs ?? TRUST_CLEAR_MS;
  let shown = false;
  let disposed = false;
  let cancel: (() => void) | null = null;

  const stop = (): void => {
    cancel?.();
    cancel = null;
  };
  const fire = (): void => {
    cancel = null;
    const next = isTrustPromptText(o.readScreen());
    if (next !== shown) {
      shown = next;
      o.onChange(next);
    }
  };

  return {
    feed() {
      if (disposed) return;
      if (shown) {
        stop();
        cancel = o.schedule(fire, clearMs);
      } else if (!cancel) {
        cancel = o.schedule(fire, detectMs);
      }
    },
    reset() {
      stop();
      shown = false;
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
