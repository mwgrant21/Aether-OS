export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptEvent {
  kind: 'assistant' | 'user' | 'other';
  sessionId: string | null;
  timestamp: Date | null;
  cwd: string | null;
  model: string | null;
  usage: TranscriptUsage | null;
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
    const usage = msg.usage
      ? {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
        }
      : null;
    return { kind: 'assistant', sessionId, timestamp, cwd, model: msg.model || null, usage };
  }

  if (json.type === 'user' && json.message) {
    return { kind: 'user', sessionId, timestamp, cwd, model: null, usage: null };
  }

  return { kind: 'other', sessionId, timestamp, cwd, model: null, usage: null };
}
