import { describe, it, expect } from 'vitest';
import { parseHookPayload } from './hookPayload.js';

describe('parseHookPayload', () => {
  it('parses a PreToolUse payload, deriving hadToolInput without keeping the input', () => {
    const raw = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd: 'C:\\Users\\test\\project',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /', foo: 'bar' },
    };
    const result = parseHookPayload(raw, 1000);
    expect(result).toEqual({
      hookEventName: 'PreToolUse',
      sessionId: 'sess-1',
      cwd: 'C:\\Users\\test\\project',
      toolName: 'Bash',
      hadToolInput: true,
      hadToolResponse: false,
      notificationType: null,
      occurredAtMs: 1000,
    });
    expect(JSON.stringify(result)).not.toContain('rm -rf');
  });

  it('parses a PostToolUse payload with a tool_response present', () => {
    const raw = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      cwd: null,
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_response: { content: 'secret file contents' },
    };
    const result = parseHookPayload(raw, 2000);
    expect(result?.hadToolResponse).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret file contents');
  });

  it('parses a Notification payload, keeping only the notification_type enum', () => {
    const raw = {
      hook_event_name: 'Notification',
      session_id: 'sess-2',
      cwd: null,
      notification_type: 'agent_needs_input',
      message: 'the agent is waiting on a decision only the user can make',
    };
    const result = parseHookPayload(raw, 3000);
    expect(result).toEqual({
      hookEventName: 'Notification',
      sessionId: 'sess-2',
      cwd: null,
      toolName: null,
      hadToolInput: false,
      hadToolResponse: false,
      notificationType: 'agent_needs_input',
      occurredAtMs: 3000,
    });
    expect(JSON.stringify(result)).not.toContain('waiting on a decision');
  });

  it('parses a Stop payload with no tool/notification fields', () => {
    const raw = { hook_event_name: 'Stop', session_id: 'sess-3', cwd: null };
    const result = parseHookPayload(raw, 4000);
    expect(result?.hookEventName).toBe('Stop');
    expect(result?.toolName).toBeNull();
  });

  it('returns null for an unrecognized hook_event_name', () => {
    const raw = { hook_event_name: 'SomeFutureEvent', session_id: 'sess-1' };
    expect(parseHookPayload(raw, 1000)).toBeNull();
  });

  it('returns null when session_id is missing or not a string', () => {
    expect(parseHookPayload({ hook_event_name: 'Stop' }, 1000)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Stop', session_id: 42 }, 1000)).toBeNull();
  });

  it('returns null for non-object input, null, arrays, and malformed shapes', () => {
    expect(parseHookPayload(null, 1000)).toBeNull();
    expect(parseHookPayload('not an object', 1000)).toBeNull();
    expect(parseHookPayload([1, 2, 3], 1000)).toBeNull();
    expect(parseHookPayload(undefined, 1000)).toBeNull();
  });

  it('defaults cwd/toolName/notificationType to null when absent, not undefined or throwing', () => {
    const raw = { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Edit' };
    const result = parseHookPayload(raw, 5000);
    expect(result?.cwd).toBeNull();
    expect(result?.notificationType).toBeNull();
  });
});
