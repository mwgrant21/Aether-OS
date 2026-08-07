// Verbosity dial for rendered narration, spec §11 Phase 1. Ships with the
// severity floor in the same change -- shipping the dial without the floor
// would let 'silent' hide ASSAY's "Treat everything unverified." sev-4
// line, which the spec calls out as the one string that must always appear.
import type { Severity } from './voicePacks';

export type NarrationVerbosity = 'full' | 'terse' | 'silent';

// Severity floor shared with narrationFeed.ts's rankForInterruption -- a
// message at or above this severity always renders regardless of the
// verbosity dial, and always interrupts regardless of the channel's
// budget. Keep both call sites importing this constant so the two floors
// can never drift apart.
export const NARRATION_FLOOR_SEVERITY: Severity = 3;

export function applyNarrationVerbosity(narration: string, level: NarrationVerbosity, severity: Severity): string | null {
  if (!narration) return null;
  if (severity >= NARRATION_FLOOR_SEVERITY) return narration; // floor: always renders
  if (level === 'silent') return null;
  return narration;
}
