import { runChatRequest } from '../src/shared/chatCore';
import { resolveModel } from '../src/shared/modelPolicy';

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
// generateHeadline afterward) counts as "a call happened" for throttling
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

// Reuses the existing chat pipeline with a Haiku-class model rather than a
// parallel one. Never throws -- a failure returns null, and callers must
// keep the dispatch's local-derived default summary (dispatch.description)
// on null, per this stage's error-handling discipline.
export async function generateHeadline(
  dispatch: DispatchForHeadline,
  trigger: HeadlineTrigger,
  blockingContext: string | null,
  apiKey: string | undefined,
  activeWorkContext: string | null = null
): Promise<string | null> {
  const system =
    trigger === 'blocked'
      ? 'Rewrite the following into a single short (under 12 words) headline that states the actual question blocking this agent, not a generic "blocked" label. Reply with only the headline text, no punctuation wrapper.'
      : 'Rewrite the following into a single short (under 12 words) status headline for a dashboard row. Reply with only the headline text.';
  const baseText = trigger === 'blocked' && blockingContext ? blockingContext : `${dispatch.subagentType}: ${dispatch.description}`;
  // activeWorkContext only ever applies to the periodic path (blocked already
  // has its own dedicated blockingContext) -- appended rather than replacing
  // baseText so the model still has the dispatch's identity, not just the
  // momentary work snippet.
  const userText = trigger === 'periodic' && activeWorkContext ? `${baseText} -- currently: ${activeWorkContext}` : baseText;

  const result = await runChatRequest({ system, messages: [{ role: 'user', text: userText }] }, apiKey, resolveModel('headline'), 40);
  if (!result.ok) return null;
  const trimmed = result.reply.trim();
  return trimmed.length > 0 ? trimmed : null;
}
