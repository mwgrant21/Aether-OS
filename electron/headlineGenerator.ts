const PERIODIC_THROTTLE_MS = 15000;

export type HeadlineTrigger = 'periodic' | 'blocked';

export interface HeadlineThrottle {
  lastCallMsByToolUseId: Map<string, number>;
}

export function createHeadlineThrottle(): HeadlineThrottle {
  return { lastCallMsByToolUseId: new Map() };
}

// Atomic check-and-set for the periodic path: an allowed periodic call
// immediately marks the throttle slot as consumed at `nowMs`, so the mere
// act of checking (even if the caller never gets around to calling
// formatHeadline afterward) counts as "a call happened" for throttling
// purposes -- this is deliberate (matches a permitted check consuming the
// slot, not just an actual dispatch) and is what makes back-to-back
// `shouldCallForHeadline` calls throttle correctly without a separate
// record step. A 'blocked' trigger never touches the map -- it is
// unconditionally allowed and never throttled, per the design spec.
export function shouldCallForHeadline(
  throttle: HeadlineThrottle,
  toolUseId: string,
  trigger: HeadlineTrigger,
  nowMs: number
): boolean {
  if (trigger === 'blocked') return true; // never throttled -- see design spec
  const last = throttle.lastCallMsByToolUseId.get(toolUseId);
  const allowed = last === undefined || nowMs - last >= PERIODIC_THROTTLE_MS;
  if (allowed) throttle.lastCallMsByToolUseId.set(toolUseId, nowMs);
  return allowed;
}

// Explicit record, kept as its own export for callers that want to mark a
// call without going through the shouldCallForHeadline gate. Not needed by
// the periodic trigger in main.ts -- shouldCallForHeadline's atomic
// check-and-set above already records on an allowed call. IS needed by the
// blocked trigger: shouldCallForHeadline never touches the map for 'blocked'
// (it's unconditionally allowed), so without an explicit recordHeadlineCall
// after a blocked call, the periodic loop's own throttle has no idea a fresh
// headline just landed and can immediately overwrite it at its next 15s
// boundary. main.ts's onNotification (blocked-trigger branch) calls this.
export function recordHeadlineCall(throttle: HeadlineThrottle, toolUseId: string, nowMs: number): void {
  throttle.lastCallMsByToolUseId.set(toolUseId, nowMs);
}

// Dedup cache for the periodic trigger: dispatch.subagentType/description are
// immutable for a dispatch's whole lifetime, so without this, every 15s
// periodic tick re-asks Haiku the identical underlying question and gets back
// a differently-worded (not more informative) answer -- billed calls with zero
// new signal. Callers feed in whatever "current content" they derived for a
// toolUseId this tick (e.g. active-work label/description); isNewPeriodicContent
// returns false (and records nothing) when it's unchanged since the last call
// that used this cache, true (and records it) when it's new or first-seen.
export interface PeriodicContentCache {
  lastContentByToolUseId: Map<string, string>;
}

export function createPeriodicContentCache(): PeriodicContentCache {
  return { lastContentByToolUseId: new Map() };
}

export function isNewPeriodicContent(cache: PeriodicContentCache, toolUseId: string, content: string): boolean {
  if (cache.lastContentByToolUseId.get(toolUseId) === content) return false;
  cache.lastContentByToolUseId.set(toolUseId, content);
  return true;
}

interface DispatchForHeadline {
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
}

const MAX_HEADLINE_LENGTH = 70;

function truncate(text: string, maxLength: number = MAX_HEADLINE_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1).trimEnd()}…` : trimmed;
}

// Notification types this app actually raises a blocked-trigger headline
// for -- see notificationHandler.ts's own check on event.notificationType.
// A type not in this map (there shouldn't be one, given that check) still
// gets a readable fallback rather than a raw enum value leaking into the UI.
const BLOCKED_LABELS: Record<string, string> = {
  permission_prompt: 'needs a permission decision',
  agent_needs_input: 'is waiting for input',
};

// Formats a dashboard-row headline from data Aether already has on hand --
// no model call, no network request, no cost. This used to ask Claude
// (Haiku) to rewrite the same inputs into prose; that made headline
// generation the one feature in this app that spent money continuously and
// unprompted (a call roughly every 15s per active agent), rather than only
// when the user took an action. Retired as part of the "Aether should not
// cost a user money" decision -- see docs/roadmap.md's Stage 11.5 addendum
// for the full rationale. This function never fails and never returns
// null/empty -- there is no I/O to fail, only string formatting -- so
// callers no longer need a null-on-failure fallback to dispatch.description;
// see main.ts and notificationHandler.ts, both simplified accordingly.
export function formatHeadline(
  dispatch: DispatchForHeadline,
  trigger: HeadlineTrigger,
  blockingContext: string | null,
  activeWorkContext: string | null = null
): string {
  if (trigger === 'blocked') {
    const label = (blockingContext && BLOCKED_LABELS[blockingContext]) ?? 'is blocked';
    return truncate(`${dispatch.subagentType} ${label}`);
  }
  const body = activeWorkContext || dispatch.description;
  return truncate(`${dispatch.subagentType}: ${body}`);
}
