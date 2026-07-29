export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface TranscriptToolResult {
  toolUseId: string;
  resultLength: number;
}

export interface TranscriptEvent {
  kind: 'assistant' | 'user' | 'other';
  sessionId: string | null;
  timestamp: Date | null;
  cwd: string | null;
  model: string | null;
  usage: TranscriptUsage | null;
  toolUses: TranscriptToolUse[];
  toolResults: TranscriptToolResult[];
  // Plain text content of a 'user'-kind message. Populated ONLY on the 'user'
  // branch, mirroring electron/transcriptParser.ts. Dispatch completions arrive
  // as user-kind 'task-notification' events whose text carries the
  // <tool-use-id>/<subagent_tokens>/<tool_uses>/<duration_ms> tags Claude Code
  // itself computes; usageIngest.ts extracts those values via regex. The text
  // itself is transient and MUST NEVER be persisted (docs/privacy-and-data.md).
  humanText: string | null;
  // json.origin?.kind, e.g. 'task-notification'. Read on every branch here
  // (electron/transcriptParser.ts only reads it on 'user' messages); only the
  // 'user' branch's value is load-bearing -- it marks dispatch completions.
  originKind: string | null;
}

export function parseTranscriptLine(rawLine: string): TranscriptEvent | null {
  const trimmed = (rawLine || '').trim();
  if (!trimmed) return null;

  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;

  const sessionId = json.sessionId || json.session_id || null;
  const timestamp = json.timestamp ? new Date(json.timestamp) : null;
  const cwd = json.cwd || null;

  if (json.type === 'assistant' && json.message) {
    const msg = json.message;
    const usage = msg.usage
      ? {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
        }
      : null;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content
      .filter((item: any) => item.type === 'tool_use')
      .map((item: any) => ({ id: item.id, name: item.name, input: item.input }));
    return {
      kind: 'assistant',
      sessionId,
      timestamp,
      cwd,
      model: msg.model || null,
      usage,
      toolUses,
      toolResults: [],
      humanText: null,
      originKind: (json.origin && json.origin.kind) || null,
    };
  }

  if (json.type === 'user' && json.message) {
    const msg = json.message;
    // Normalized the same way electron/transcriptParser.ts does: a bare string
    // message.content is treated as a single text item so humanText is derived
    // consistently regardless of which shape the transcript line uses.
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    const toolResults = content
      .filter((item: any) => item.type === 'tool_result')
      .map((item: any) => ({
        toolUseId: item.tool_use_id,
        resultLength: JSON.stringify(item.content ?? '').length,
      }));
    const textItem = content.find((item: any) => item.type === 'text');
    return {
      kind: 'user',
      sessionId,
      timestamp,
      cwd,
      model: null,
      usage: null,
      toolUses: [],
      toolResults,
      humanText: textItem ? textItem.text : null,
      originKind: (json.origin && json.origin.kind) || null,
    };
  }

  return {
    kind: 'other',
    sessionId,
    timestamp,
    cwd,
    model: null,
    usage: null,
    toolUses: [],
    toolResults: [],
    humanText: null,
    originKind: (json.origin && json.origin.kind) || null,
  };
}
