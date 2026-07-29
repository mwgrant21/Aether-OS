import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from './transcriptParser.js';

describe('parseTranscriptLine', () => {
  it('parses an assistant line with usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: '2026-07-08T09:00:00Z',
      cwd: '/proj',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
        content: [],
      },
    });
    const result = parseTranscriptLine(line);
    expect(result).toEqual({
      kind: 'assistant',
      sessionId: 'sess-1',
      timestamp: new Date('2026-07-08T09:00:00Z'),
      cwd: '/proj',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 },
      toolUses: [],
      toolResults: [],
      originKind: null,
    });
  });

  it('parses an assistant line missing usage as usage: null', () => {
    const line = JSON.stringify({ type: 'assistant', sessionId: 's1', message: { model: 'x', content: [] } });
    const result = parseTranscriptLine(line);
    expect(result?.usage).toBeNull();
  });

  it('parses a user line as kind: user, usage: null, model: null', () => {
    const line = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hello' } });
    const result = parseTranscriptLine(line);
    expect(result).toEqual({
      kind: 'user',
      sessionId: 's1',
      timestamp: null,
      cwd: null,
      model: null,
      usage: null,
      toolUses: [],
      toolResults: [],
      originKind: null,
    });
  });

  it('parses an unrecognized type as kind: other', () => {
    const line = JSON.stringify({ type: 'summary', sessionId: 's1' });
    const result = parseTranscriptLine(line);
    expect(result?.kind).toBe('other');
  });

  it('returns null for empty or whitespace-only lines', () => {
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   \n')).toBeNull();
  });

  it('returns null for malformed JSON, never throws', () => {
    expect(() => parseTranscriptLine('not json{{')).not.toThrow();
    expect(parseTranscriptLine('not json{{')).toBeNull();
  });

  it('defaults missing sessionId/cwd/timestamp to null rather than throwing', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const result = parseTranscriptLine(line);
    expect(result?.sessionId).toBeNull();
    expect(result?.cwd).toBeNull();
    expect(result?.timestamp).toBeNull();
  });

  it('accepts session_id (snake_case) as a fallback for sessionId', () => {
    const line = JSON.stringify({ type: 'user', session_id: 's2', message: { content: '' } });
    const result = parseTranscriptLine(line);
    expect(result?.sessionId).toBe('s2');
  });

  it('returns null for valid JSON that parses to null, a bare array, or a primitive, never throwing', () => {
    expect(() => parseTranscriptLine('null')).not.toThrow();
    expect(parseTranscriptLine('null')).toBeNull();
    expect(() => parseTranscriptLine('[]')).not.toThrow();
    expect(parseTranscriptLine('[]')).toBeNull();
    expect(() => parseTranscriptLine('123')).not.toThrow();
  });
});

describe('parseTranscriptLine tool use/result parsing', () => {
  it('extracts toolUses from an assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-28T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-5',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/abs/path/foo.ts' } },
          { type: 'text', text: 'reading' },
        ],
      },
    });
    const event = parseTranscriptLine(line);
    expect(event?.toolUses).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: '/abs/path/foo.ts' } }]);
  });

  it('extracts toolResults from a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-28T00:00:01.000Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }],
      },
    });
    const event = parseTranscriptLine(line);
    expect(event?.toolResults).toEqual([{ toolUseId: 'tu_1', resultLength: 20 }]);
  });

  it('returns empty arrays for events with no tool activity', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const event = parseTranscriptLine(line);
    expect(event?.toolUses).toEqual([]);
    expect(event?.toolResults).toEqual([]);
  });

  it('extracts originKind from json.origin.kind on an assistant line', () => {
    const line = JSON.stringify({
      type: 'assistant',
      origin: { kind: 'task-notification' },
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    });
    const event = parseTranscriptLine(line);
    expect(event?.originKind).toBe('task-notification');
  });

  it('extracts originKind from json.origin.kind on a user line', () => {
    const line = JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { content: 'done' },
    });
    const event = parseTranscriptLine(line);
    expect(event?.originKind).toBe('task-notification');
  });

  it('defaults originKind to null when json.origin is absent', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const event = parseTranscriptLine(line);
    expect(event?.originKind).toBeNull();
  });
});
