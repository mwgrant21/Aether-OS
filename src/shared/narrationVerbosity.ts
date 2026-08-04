// Verbosity dial for rendered narration, spec §11 Phase 1. Ships with the
// severity floor in the same change -- shipping the dial without the floor
// would let 'silent' hide ASSAY's "Treat everything unverified." sev-4
// line, which the spec calls out as the one string that must always appear.
import type { Severity } from './voicePacks';

export type NarrationVerbosity = 'full' | 'terse' | 'silent';

export function applyNarrationVerbosity(narration: string, level: NarrationVerbosity, severity: Severity): string | null {
  if (!narration) return null;
  if (severity >= 3) return narration; // floor: always renders
  if (level === 'silent') return null;
  return narration;
}
