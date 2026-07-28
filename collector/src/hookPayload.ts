export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

const KNOWN_EVENT_NAMES: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];

export interface ParsedHookEvent {
  hookEventName: HookEventName;
  sessionId: string;
  cwd: string | null;
  toolName: string | null;
  hadToolInput: boolean;
  hadToolResponse: boolean;
  notificationType: string | null;
  occurredAtMs: number;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses one raw hook JSON payload (as Claude Code sends it on stdin) into the
 * minimal derived shape this collector persists. Deliberately drops
 * `tool_input`/`tool_response`/`message` content entirely -- only their
 * *presence* is recorded (privacy-and-data.md SS4: store the signal, not the
 * payload). Never throws: any malformed or unrecognized shape returns null,
 * which callers must treat as "skip this line," not an error.
 */
export function parseHookPayload(raw: unknown, receivedAtMs: number): ParsedHookEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const hookEventName = stringField(obj, 'hook_event_name');
  if (hookEventName === null || !KNOWN_EVENT_NAMES.includes(hookEventName as HookEventName)) return null;

  const sessionId = stringField(obj, 'session_id');
  if (sessionId === null) return null;

  return {
    hookEventName: hookEventName as HookEventName,
    sessionId,
    cwd: stringField(obj, 'cwd'),
    toolName: stringField(obj, 'tool_name'),
    hadToolInput: obj.tool_input !== undefined && obj.tool_input !== null,
    hadToolResponse: obj.tool_response !== undefined && obj.tool_response !== null,
    notificationType: stringField(obj, 'notification_type'),
    occurredAtMs: receivedAtMs,
  };
}
