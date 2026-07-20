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
  isHumanPrompt: boolean;
  humanText: string | null;
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

  const sessionId = json.sessionId || json.session_id || null;
  const timestamp = json.timestamp ? new Date(json.timestamp) : null;
  const cwd = json.cwd || null;

  if (json.type === 'assistant' && json.message) {
    const msg = json.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolUses = content
      .filter((item: any) => item.type === 'tool_use')
      .map((item: any) => ({ id: item.id, name: item.name, input: item.input }));
    const usage = msg.usage
      ? {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
        }
      : null;
    return {
      kind: 'assistant',
      sessionId,
      timestamp,
      cwd,
      model: msg.model || null,
      usage,
      toolUses,
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };
  }

  if (json.type === 'user' && json.message) {
    const msg = json.message;
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    const toolResults = content
      .filter((item: any) => item.type === 'tool_result')
      .map((item: any) => ({ toolUseId: item.tool_use_id }));
    const textItem = content.find((item: any) => item.type === 'text');
    const isHumanPrompt = toolResults.length === 0 && !!textItem;
    return {
      kind: 'user',
      sessionId,
      timestamp,
      cwd,
      model: null,
      usage: null,
      toolUses: [],
      toolResults,
      isHumanPrompt,
      humanText: textItem ? textItem.text : null,
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
    isHumanPrompt: false,
    humanText: null,
  };
}
