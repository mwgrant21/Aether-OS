// electron/narrationGenerator.ts
// Pure, deterministic -- no model call, no I/O, cannot fail (same shape as
// headlineGenerator.ts's formatHeadline(), for the same "Aether should not
// cost a user money" reason -- see docs/roadmap.md's Stage 11.5 addendum).
// severity is computed here the same way collector/src/personalitySpine.ts's
// computeSeverity does for a completed, non-erroring dispatch: exit 'ok',
// retries 0 -- this stage's data source (CompletedDispatchUsage, from
// liveAgentTracker.tick()) doesn't carry retries/exit yet, so those two
// inputs are the same fixed values Stage 11's own ingestDispatchEvent uses
// for its first consumer. See this plan's design doc for why this doesn't
// need collectorStore.ts's (separately, already-named) stale telemetry
// reader.
import { resolveVoiceRole } from '../src/shared/agentVoiceRoles';
import { VOICE_PACKS, type Severity } from '../src/shared/voicePacks';
import { renderNarration } from '../src/shared/voiceRender';

export interface DispatchForNarration {
  subagentType: string;
  durationMs: number;
}

function computeNarrationSeverity(durationMs: number, medianMsAtEval: number | null): Severity {
  let sev = 1;
  if (medianMsAtEval !== null && durationMs > 3 * medianMsAtEval) sev += 1;
  return Math.min(4, sev) as Severity;
}

export function formatNarration(dispatch: DispatchForNarration, medianMsAtEval: number | null): string | null {
  const role = resolveVoiceRole(dispatch.subagentType);
  const pack = VOICE_PACKS[role];
  const severity = computeNarrationSeverity(dispatch.durationMs, medianMsAtEval);
  const narration = renderNarration(pack, severity, null);
  return narration || null;
}
