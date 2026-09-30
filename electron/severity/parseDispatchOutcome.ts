// electron/severity/parseDispatchOutcome.ts
// Pure. Reads an Agent dispatch's outcome from its task-notification text.
// Never throws. The result holds NO string except `status`: the <summary> and
// <result> bodies are transcript content, and they are removed BEFORE any tag
// is matched, so a result that quotes "<status>failed</status>" cannot flip
// the outcome. Spec: docs/superpowers/specs/2026-09-30-real-severity-design.md
// sections 3, 4 and 9.
//
// SOURCE OF TRUTH for collector/src/severity/parseDispatchOutcome.ts, which
// scripts/sync-severity-core.mjs generates. Edit here, then re-run it.

export type DispatchStatus = 'completed' | 'failed' | 'killed' | 'unknown';

export interface DispatchUsage {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export interface DispatchOutcome {
  status: DispatchStatus;
  usage?: DispatchUsage;
}

const CONTENT_BLOCKS = /<(summary|result)>[\s\S]*?<\/\1>/g;
const STATUS_TAG = /<status>([^<]*)<\/status>/;
const TOKENS_TAG = /<subagent_tokens>(\d+)<\/subagent_tokens>/;
const TOOL_USES_TAG = /<tool_uses>(\d+)<\/tool_uses>/;
const DURATION_TAG = /<duration_ms>(\d+)<\/duration_ms>/;
const DIAG_SAFE_TAG = /^[a-z_]{1,24}$/;

function structuralPart(text: string): string {
  return text.replace(CONTENT_BLOCKS, '');
}

function recognised(raw: string): raw is 'completed' | 'failed' | 'killed' {
  return raw === 'completed' || raw === 'failed' || raw === 'killed';
}

export function parseDispatchOutcome(notificationText: unknown): DispatchOutcome {
  if (typeof notificationText !== 'string') return { status: 'unknown' };
  const text = structuralPart(notificationText);

  const statusMatch = STATUS_TAG.exec(text);
  const raw = statusMatch ? statusMatch[1].trim() : '';
  const status: DispatchStatus = recognised(raw) ? raw : 'unknown';

  const tokens = TOKENS_TAG.exec(text);
  const toolUses = TOOL_USES_TAG.exec(text);
  const duration = DURATION_TAG.exec(text);
  if (tokens && toolUses && duration) {
    return {
      status,
      usage: { tokens: Number(tokens[1]), toolUses: Number(toolUses[1]), durationMs: Number(duration[1]) },
    };
  }
  return { status };
}

// For the one-per-value [diag] line ONLY, never for storage. Returns null
// when the status is recognised. Otherwise returns a short lowercase word,
// '<missing>', or '<unprintable>', so no free text can reach a log.
export function unrecognisedStatusTag(notificationText: unknown): string | null {
  if (typeof notificationText !== 'string') return '<missing>';
  const statusMatch = STATUS_TAG.exec(structuralPart(notificationText));
  if (!statusMatch) return '<missing>';
  const raw = statusMatch[1].trim();
  if (recognised(raw)) return null;
  return DIAG_SAFE_TAG.test(raw) ? raw : '<unprintable>';
}
