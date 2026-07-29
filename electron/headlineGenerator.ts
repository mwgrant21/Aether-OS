import { runChatRequest } from '../src/shared/chatCore';

export const HAIKU_MODEL = 'claude-haiku-4-5';
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
// check-and-set above already records on an allowed call.
export function recordHeadlineCall(throttle: HeadlineThrottle, toolUseId: string, nowMs: number): void {
  throttle.lastCallMsByToolUseId.set(toolUseId, nowMs);
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
  apiKey: string | undefined
): Promise<string | null> {
  const system =
    trigger === 'blocked'
      ? 'Rewrite the following into a single short (under 12 words) headline that states the actual question blocking this agent, not a generic "blocked" label. Reply with only the headline text, no punctuation wrapper.'
      : 'Rewrite the following into a single short (under 12 words) status headline for a dashboard row. Reply with only the headline text.';
  const userText = trigger === 'blocked' && blockingContext ? blockingContext : `${dispatch.subagentType}: ${dispatch.description}`;

  const result = await runChatRequest({ system, messages: [{ role: 'user', text: userText }] }, apiKey, HAIKU_MODEL, 40);
  if (!result.ok) return null;
  const trimmed = result.reply.trim();
  return trimmed.length > 0 ? trimmed : null;
}
