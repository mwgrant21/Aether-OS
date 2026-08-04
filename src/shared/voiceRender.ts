// Deterministic narration renderer -- no model call (see this plan's Global
// Constraints; spec section 6's "generated flesh" is replaced with "selected
// flesh" for the same no-cost reason formatHeadline() already applies).
import type { VoicePack, Severity, EventKind } from './voicePacks';

// Fleet defaults, spec section 5.3. Per-pack register.max_chars overrides these.
export const FLEET_MAX_CHARS: Record<Severity, number> = { 0: 0, 1: 140, 2: 160, 3: 140, 4: 110 };

function pickSample(pack: VoicePack, severity: Severity): string {
  const direct = pack.samples[severity];
  if (direct !== undefined) return direct;
  // Walk down to the nearest lower severity with a sample (e.g. FORGE has
  // no sev-1 sample by design -- spec section 5.9's silent heartbeat). Severity 1
  // with nothing below it renders empty, which callers treat as "no line",
  // matching FORGE's narration:null contract at the caller layer (Task 7).
  for (let s = severity - 1; s >= 1; s--) {
    const fallback = pack.samples[s as Severity];
    if (fallback !== undefined) return fallback;
  }
  return '';
}

function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastBoundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.', slice.length - 1));
  if (lastBoundary > 0 && slice[lastBoundary] === '.') {
    return slice.slice(0, lastBoundary + 1);
  }
  // No sentence boundary fits inside the cap at all -- hard truncate is the
  // documented fallback (spec section 5.3: "a hard-truncated line reads as a bug,
  // not as terseness", accepted as the last resort when re-prompting isn't
  // possible because there is no model call to re-prompt).
  return slice.trimEnd();
}

export function renderNarration(pack: VoicePack, severity: Severity, eventKind?: EventKind | null): string {
  const base = pickSample(pack, severity);
  if (!base) return '';

  const frozen = eventKind ? pack.frozen[eventKind] : undefined;
  let full = base;
  if (frozen && !base.startsWith(frozen)) {
    full = `${frozen} ${base}`;
  }

  const cap = pack.register.max_chars?.[severity] ?? FLEET_MAX_CHARS[severity];
  return truncateAtSentenceBoundary(full, cap);
}
