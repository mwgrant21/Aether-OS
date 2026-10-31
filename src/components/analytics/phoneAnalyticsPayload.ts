// Builds the phone `analytics` view payload (privacy section 17) in the renderer, from the same pure functions the
// Analytics pane draws from. Free text is limited to dispatch descriptions/types and the first word of the owner's own
// typed commands; main masks and caps it again in encodeAnalyticsView. Never sent: raw `logs`, a dispatch `prompt`, a
// full command line. Commands mirror the desktop TopCommandsCard: the full persisted `state.cmdHist` (last 30 lines,
// kept across restarts), not the session-only history.
import type { AetherState } from '../../state/types';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import { computeCompletedDispatchBurn, computeLogFrequency, computeRealAgentBreakdown, computeTopCommands } from './analyticsMath';

export const ANALYTICS_LONGEST_CAP = 8;
export const ANALYTICS_BURN_CAP = 5;
export const ANALYTICS_COMMANDS_CAP = 5;

const goodNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const goodStart = (a: RealAgentDispatch): boolean => Number.isFinite(new Date(a.startedAt).getTime());

/**
 * nowMs is the publish instant, sent as computedAtMs. A row with a non-finite number (an unparseable start time, a NaN
 * token count) is dropped on its own instead of nulling the whole payload; elapsed time is sent as the start instant so
 * the phone can tick it against the titan clock.
 */
export function phoneAnalyticsPayload(state: AetherState, nowMs: number): Record<string, unknown> {
  const [success, info, denied, other] = computeLogFrequency(state.logs).map((r) => r.count);
  const longest = computeRealAgentBreakdown(state.realAgents.filter(goodStart), nowMs)
    .slice(0, ANALYTICS_LONGEST_CAP)
    .map((r) => ({ type: r.subagentType, description: r.description, startedAtMs: Math.round(nowMs - r.elapsedMs) }));
  const burn = computeCompletedDispatchBurn(state.recentCompletedDispatches, state.dispatchUsage, Number.MAX_SAFE_INTEGER)
    .filter((r) => goodNum(r.tokens) && r.tokens >= 0 && goodNum(r.durationMs) && r.durationMs >= 0)
    .slice(0, ANALYTICS_BURN_CAP)
    .map((r) => ({
      type: r.subagentType,
      description: r.description,
      tokens: r.tokens,
      toolUses: goodNum(r.toolUses) && r.toolUses >= 0 ? r.toolUses : null,
      durationMs: r.durationMs,
    }));
  const commands = computeTopCommands(state.cmdHist, ANALYTICS_COMMANDS_CAP).map((c) => ({ name: c.name, count: c.count }));
  return { computedAtMs: nowMs, logs: { success, info, denied, other }, longest, burn, commands };
}
