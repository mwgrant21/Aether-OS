// GENERATED from electron/severity/parseDispatchOutcome.ts by scripts/sync-severity-core.mjs -- do not edit.
// Edit the electron copy, then run: node scripts/sync-severity-core.mjs
// electron/severity/parseDispatchOutcome.ts
// Pure. Reads an Agent dispatch's outcome from its task-notification text.
// Never throws. The result holds NO string except `status`. The <summary> and
// <result> bodies are transcript content, so fields are anchored by POSITION,
// never by a global match: real shape is status, summary, result, usage.
// <status> is read only from the text BEFORE the first <summary>/<result>
// opening tag; usage only from the text AFTER the last </summary>/</result>,
// and not at all if an opening tag still follows that point (truncated body).
// Spec: docs/superpowers/specs/2026-09-30-real-severity-design.md
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

const CONTENT_OPEN = /<(summary|result)>/;
const STATUS_TAG = /<status>([^<]*)<\/status>/;
const TOKENS_TAG = /<subagent_tokens>(\d+)<\/subagent_tokens>/;
const TOOL_USES_TAG = /<tool_uses>(\d+)<\/tool_uses>/;
const DURATION_TAG = /<duration_ms>(\d+)<\/duration_ms>/;
const DIAG_SAFE_TAG = /^[a-z_]{1,24}$/;

function headPart(text: string): string {
  const m = CONTENT_OPEN.exec(text);
  return m ? text.slice(0, m.index) : text;
}

// Text after the last content close tag, or null when that tail still holds
// an opening tag, or when a <task-notification> opener has no closer
// (truncated body: nothing after it can be trusted).
function usagePart(text: string): string | null {
  const end = Math.max(
    text.lastIndexOf('</result>') < 0 ? -1 : text.lastIndexOf('</result>') + 9,
    text.lastIndexOf('</summary>') < 0 ? -1 : text.lastIndexOf('</summary>') + 10,
  );
  const tail = end < 0 ? text : text.slice(end);
  if (CONTENT_OPEN.test(tail)) return null;
  // A wrapped notification is trusted only if it is closed: a cut-off body that
  // quotes </result> must not lend its trailing text to the usage block.
  if (text.includes('<task-notification>') && !text.includes('</task-notification>')) return null;
  return tail;
}

function recognised(raw: string): raw is 'completed' | 'failed' | 'killed' {
  return raw === 'completed' || raw === 'failed' || raw === 'killed';
}

export function parseDispatchOutcome(notificationText: unknown): DispatchOutcome {
  if (typeof notificationText !== 'string') return { status: 'unknown' };
  const statusMatch = STATUS_TAG.exec(headPart(notificationText));
  const raw = statusMatch ? statusMatch[1].trim() : '';
  const status: DispatchStatus = recognised(raw) ? raw : 'unknown';

  const tail = usagePart(notificationText);
  if (tail === null) return { status };
  const tokens = TOKENS_TAG.exec(tail);
  const toolUses = TOOL_USES_TAG.exec(tail);
  const duration = DURATION_TAG.exec(tail);
  if (tokens && toolUses && duration) {
    const usage = { tokens: Number(tokens[1]), toolUses: Number(toolUses[1]), durationMs: Number(duration[1]) };
    if (Object.values(usage).every(Number.isSafeInteger)) return { status, usage };
  }
  return { status };
}

// For the one-per-value [diag] line ONLY, never for storage. Returns null
// when the status is recognised. Otherwise returns a short lowercase word,
// '<missing>', or '<unprintable>', so no free text can reach a log.
export function unrecognisedStatusTag(notificationText: unknown): string | null {
  if (typeof notificationText !== 'string') return '<missing>';
  const statusMatch = STATUS_TAG.exec(headPart(notificationText));
  if (!statusMatch) return '<missing>';
  const raw = statusMatch[1].trim();
  if (recognised(raw)) return null;
  return DIAG_SAFE_TAG.test(raw) ? raw : '<unprintable>';
}
