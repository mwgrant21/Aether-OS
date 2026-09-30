// electron/liveTickCompletions.ts
// Per-completion work for one liveAgentTracker.tick() result. main.ts calls
// tick() from two places (the periodic agent tick and the onPostToolUse hook),
// and each call CONSUMES the transcript lines it reads, so a completion seen
// by either one must be handled here or it is lost: no narration, no baseline
// record, no "Recovered." line for a stalled dispatch, no agents:completed.
// Both sites call this; the stall check stays with the periodic tick only.
import type { LiveAgentTick } from './liveAgentTracker';
import type { LiveNarrationPayload, LiveSeverityNarrator } from './severity/liveSeverity';
import type { CompletedDispatchUsage } from '../src/state/liveAgentsMath';

export interface TickCompletionDeps {
  narrator: Pick<LiveSeverityNarrator, 'onCompleted'>;
  reportUnseenStatus: (tag: string | null) => void;
  sendNarration: (payload: LiveNarrationPayload) => void;
  sendCompleted: (completed: CompletedDispatchUsage[]) => void;
}

export function createTickCompletionHandler(deps: TickCompletionDeps): (result: Pick<LiveAgentTick, 'completed' | 'outcomes'>) => void {
  return (result) => {
    for (const c of result.completed) {
      // WALL CLOCK, deliberately. This used to subtract the time the app spent
      // blocked on an approval prompt, on the theory that a dispatch which sat
      // waiting for the operator should not read as "slower than usual".
      //
      // That subtraction was removed because it could not be made correct. Read
      // docs/superpowers/specs/2026-09-16-user-wait-subtraction-removal.md
      // BEFORE attempting to reintroduce it -- the short version is that a
      // subagent's tool calls are not written to the transcript at all, so a
      // prompt raised inside a dispatch can never be attributed back to it, and
      // a prompt raised on the main thread does not block the dispatch it would
      // have been subtracted from. Every correction it made was therefore taken
      // from a dispatch that had not waited. (Here: outcome.usage.durationMs, the
      // notification's own <duration_ms>, fed to onCompleted as is.)
      //
      // liveSeverity.onCompleted snapshots the baseline BEFORE recording this
      // run, so a run is never compared against a baseline it contributed to.
      const tracked = result.outcomes.get(c.toolUseId);
      deps.reportUnseenStatus(tracked?.unknownStatusTag ?? null);
      const payload = deps.narrator.onCompleted(c, tracked);
      if (payload) deps.sendNarration(payload);
    }
    if (result.completed.length) deps.sendCompleted(result.completed);
  };
}
