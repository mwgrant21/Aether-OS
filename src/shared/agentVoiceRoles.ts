// Maps a real dispatch's subagent_type (collector/src/toolCallHistory.ts's
// extractSubagentType, e.g. "code-reviewer", "general-purpose") onto one of
// the 5 fixed voice-pack roles (spec §5.1). Voice packs key on role, not on
// the freeform subagent_type string, so this table is the seam between them.
// Mirrors src/components/chat/personas.ts's own FALLBACK_PERSONA pattern:
// a static map with a named default rather than a heuristic.
export type VoiceRole = 'STEWARD' | 'CINDER' | 'PILGRIM' | 'ASSAY' | 'FORGE';

const ROLE_MAP: Record<string, VoiceRole> = {
  'project-orchestrator': 'STEWARD',
  'design-studio-pm': 'STEWARD',

  'code-reviewer': 'CINDER',
  'silent-failure-hunter': 'CINDER',
  'comment-analyzer': 'CINDER',
  'type-design-analyzer': 'CINDER',
  'security-code-reviewer': 'CINDER',
  'ps-code-reviewer': 'CINDER',

  'Explore': 'PILGRIM',
  'general-purpose': 'FORGE',

  'pr-test-analyzer': 'ASSAY',
  'post-deployment-validator': 'ASSAY',
  'compliance-baseline-agent': 'ASSAY',
};

// Unmapped subagent_type -> FORGE. FORGE ("works, does not narrate working")
// is the safest default for an unknown builder-shaped task -- it is silent
// at nominal severity, so an unrecognized agent doesn't produce noisy
// narration by default.
export function resolveVoiceRole(subagentType: string): VoiceRole {
  return ROLE_MAP[subagentType] ?? 'FORGE';
}
