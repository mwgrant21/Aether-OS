const RECOGNIZED_VERBS = ['spawn', 'kill', 'theme', 'renderer', 'throttle'] as const;
export type ActionVerb = (typeof RECOGNIZED_VERBS)[number];

export interface ChatAction {
  verb: ActionVerb;
  args: Record<string, unknown>;
}

function isRecognizedVerb(v: unknown): v is ActionVerb {
  return typeof v === 'string' && (RECOGNIZED_VERBS as readonly string[]).includes(v);
}

// Detects Phase 2a's system-prompt-documented convention: an optional final
// line containing a compact JSON object {"verb": ..., "args": {...}}. Only
// strips/parses it when the verb is one of the five real, recognized ones
// AND args is present as an object -- any other case (no JSON line, invalid
// JSON, unrecognized verb like a stray "status", missing/non-object args)
// leaves the reply completely untouched and returns action: null. Never
// throws, regardless of input. Only ever called against a genuine askClaude
// reply -- never against localResponder's offline fallback text (see
// useChatChannels.ts / Global Constraints).
export function parseActionLine(reply: string): { text: string; action: ChatAction | null } {
  const lines = reply.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return { text: reply, action: null };

  const lastLine = lines[lines.length - 1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { text: reply, action: null };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { text: reply, action: null };
  const obj = parsed as Record<string, unknown>;
  if (!isRecognizedVerb(obj.verb)) return { text: reply, action: null };
  if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) return { text: reply, action: null };

  const strippedText = lines.slice(0, -1).join('\n').trimEnd();
  return { text: strippedText, action: { verb: obj.verb, args: obj.args as Record<string, unknown> } };
}
