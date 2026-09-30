// electron/narrationGenerator.ts
// Pure, deterministic -- no model call, no I/O, cannot fail (same shape as
// headlineGenerator.ts's formatHeadline(), for the same "Aether should not
// cost a user money" reason -- see docs/roadmap.md's Stage 11.5 addendum).
// Render only: severity is computed by electron/severity/computeSeverity.ts
// (via electron/severity/liveSeverity.ts) and passed in. The local severity
// copy that lived here could only produce 1 or 2 and was deleted by
// docs/superpowers/specs/2026-09-30-real-severity-design.md section 4.
import { resolveVoiceRole } from '../src/shared/agentVoiceRoles';
import { VOICE_PACKS, type Severity } from '../src/shared/voicePacks';
import { renderNarration } from '../src/shared/voiceRender';

export interface NarrationResult {
  narration: string;
  severity: Severity;
}

export function formatNarration(dispatch: { subagentType: string }, severity: Severity): NarrationResult | null {
  const pack = VOICE_PACKS[resolveVoiceRole(dispatch.subagentType)];
  const narration = renderNarration(pack, severity, null);
  return narration ? { narration, severity } : null;
}

// The `narrate` dependency main.ts hands to createLiveSeverityNarrator: the
// rendered line alone, or null when the role is silent at this severity.
export function narrationLine(subagentType: string, severity: Severity): string | null {
  return formatNarration({ subagentType }, severity)?.narration ?? null;
}
