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
      humanText: null,
      originKind: null,
    });
  });

  it('derives messageKey "msg:req" from message.id and requestId on an assistant line', () => {
    const line = JSON.stringify({ type: 'assistant', requestId: 'req', message: { id: 'msg', content: [] } });
    expect(parseTranscriptLine(line)?.messageKey).toBe('msg:req');
  });

  it('uses an empty requestId part when absent, and no messageKey without message.id', () => {
    const noReq = JSON.stringify({ type: 'assistant', message: { id: 'msg', content: [] } });
    expect(parseTranscriptLine(noReq)?.messageKey).toBe('msg:');
    const noId = JSON.stringify({ type: 'assistant', requestId: 'req', message: { content: [] } });
    expect(parseTranscriptLine(noId)?.messageKey ?? null).toBeNull();
    const emptyId = JSON.stringify({ type: 'assistant', requestId: 'req', message: { id: '', content: [] } });
    expect(parseTranscriptLine(emptyId)?.messageKey ?? null).toBeNull();
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
      humanText: 'hello',
      originKind: null,
    });
  });

  it('populates humanText from a text-type content item on a user line', () => {
    const line = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      origin: { kind: 'task-notification' },
      message: { content: [{ type: 'text', text: '<tool-use-id>tu_1</tool-use-id>' }] },
    });
    const result = parseTranscriptLine(line);
    expect(result?.humanText).toBe('<tool-use-id>tu_1</tool-use-id>');
  });

  it('leaves humanText null on a user line with no text content item', () => {
    const line = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    });
    expect(parseTranscriptLine(line)?.humanText).toBeNull();
  });

  it('leaves humanText null on assistant and other events', () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { model: 'x', content: [{ type: 'text', text: 'not a human prompt' }] },
    });
    expect(parseTranscriptLine(assistant)?.humanText).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: 'summary' }))?.humanText).toBeNull();
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

  it('parses an unparseable timestamp as null, not an Invalid Date', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: 'not-a-date', message: { content: [] } });
    expect(parseTranscriptLine(line)?.timestamp).toBeNull();
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

  it('flags only the "Async agent launched" ack as asyncLaunch, for array and string content', () => {
    const line = (content: unknown) => JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }] },
    });
    const ack = 'Async agent launched successfully. (This tool result is ...';
    const flag = (content: unknown) => parseTranscriptLine(line(content))?.toolResults[0].asyncLaunch;
    expect(flag([{ type: 'text', text: ack }])).toBe(true);
    expect(flag(ack)).toBe(true);
    expect(flag([{ type: 'text', text: 'Fork started — processing in background' }])).toBeFalsy();
    expect(flag('Failed to create worktree')).toBeFalsy();
    expect(flag([{ type: 'text', text: 'all done' }])).toBeFalsy();
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

  describe('queued_command task-notification attachments', () => {
    const prompt = '<task-notification><tool-use-id>tu_q</tool-use-id><tool_uses>7</tool_uses></task-notification>';
    const attachmentLine = (commandMode: string) =>
      JSON.stringify({
        type: 'attachment',
        sessionId: 's1',
        timestamp: '2026-07-08T09:00:00Z',
        attachment: { type: 'queued_command', prompt, commandMode },
      });

    it('parses a task-notification queued_command attachment as a user-kind task-notification', () => {
      const event = parseTranscriptLine(attachmentLine('task-notification'));
      expect(event).toMatchObject({
        kind: 'user',
        sessionId: 's1',
        timestamp: new Date('2026-07-08T09:00:00Z'),
        originKind: 'task-notification',
        humanText: prompt,
        toolUses: [],
        toolResults: [],
      });
    });

    it('leaves a queued_command with another commandMode as kind other', () => {
      const event = parseTranscriptLine(attachmentLine('prompt'));
      expect(event?.kind).toBe('other');
      expect(event?.originKind).toBeNull();
    });

    it('parses a queue-operation enqueue carrying a task-notification as a user-kind task-notification', () => {
      const line = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-07-08T09:00:00Z', sessionId: 's1', content: prompt });
      expect(parseTranscriptLine(line)).toMatchObject({
        kind: 'user',
        sessionId: 's1',
        originKind: 'task-notification',
        humanText: prompt,
        toolResults: [],
      });
    });

    it.each(['remove', 'dequeue'])('leaves a queue-operation %s carrying the notification as kind other', (operation) => {
      const line = JSON.stringify({ type: 'queue-operation', operation, sessionId: 's1', content: prompt });
      const event = parseTranscriptLine(line);
      expect(event?.kind).toBe('other');
      expect(event?.originKind).toBeNull();
    });

    it('leaves a queue-operation enqueue of an ordinary prompt, or with no content, as kind other', () => {
      for (const content of ['please run the tests', undefined, 42]) {
        const event = parseTranscriptLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: 's1', content }));
        expect(event?.kind).toBe('other');
        expect(event?.originKind).toBeNull();
      }
    });
  });

  describe('hand-back reports', () => {
    const origin = { kind: 'peer', from: 'agent-from', senderTaskId: 'a1b2c3', name: 'CINDER', handback: true, handbackReportText: 'REAL REPORT' };
    const framed = '<agent-message from="a1b2c3">REAL REPORT</agent-message>';
    const userLine = (o: unknown) =>
      JSON.stringify({ type: 'user', isMeta: true, sessionId: 's1', origin: o, message: { role: 'user', content: framed } });
    const attLine = (o: unknown) =>
      JSON.stringify({ type: 'attachment', sessionId: 's1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: framed, origin: o } });

    it('exposes handback on the user shape and keeps originKind peer', () => {
      const event = parseTranscriptLine(userLine(origin));
      expect(event?.handback).toEqual({ agentId: 'a1b2c3', reportText: 'REAL REPORT' });
      expect(event?.kind).toBe('user');
      expect(event?.originKind).toBe('peer');
    });

    it('exposes handback on the attachment shape, still kind other with null originKind', () => {
      const event = parseTranscriptLine(attLine(origin));
      expect(event?.handback).toEqual({ agentId: 'a1b2c3', reportText: 'REAL REPORT' });
      expect(event?.kind).toBe('other');
      expect(event?.originKind).toBeNull();
    });

    it('falls back to origin.from when senderTaskId is missing', () => {
      const { senderTaskId, ...rest } = origin;
      expect(parseTranscriptLine(userLine(rest))?.handback?.agentId).toBe('agent-from');
      expect(parseTranscriptLine(attLine(rest))?.handback?.agentId).toBe('agent-from');
    });

    const { handbackReportText, ...noText } = origin;
    const { senderTaskId, from, ...noId } = origin;
    it.each([
      ['missing text', noText],
      ['empty text', { ...origin, handbackReportText: '' }],
      ['whitespace text', { ...origin, handbackReportText: '   ' }],
      ['non-string text', { ...origin, handbackReportText: 42 }],
      ['handback not true', { ...origin, handback: 'true' }],
      ['handback absent', { kind: 'peer', from: 'x', handbackReportText: 'T' }],
      ['task-notification origin', { kind: 'task-notification' }],
      ['string origin', 'peer'],
      ['null origin', null],
      ['array origin', [origin]],
      ['number origin', 7],
      ['no agent id', noId],
    ])('yields no handback key for %s', (_name, o) => {
      for (const line of [userLine(o), attLine(o)]) {
        const event = parseTranscriptLine(line);
        expect(event).not.toBeNull();
        expect(event).not.toHaveProperty('handback');
      }
    });

    it('carries no handback on queue-operation records or ordinary task-notification attachments', () => {
      for (const operation of ['enqueue', 'remove']) {
        const event = parseTranscriptLine(JSON.stringify({ type: 'queue-operation', operation, sessionId: 's1', content: framed }));
        expect(event).not.toHaveProperty('handback');
      }
      const note = JSON.stringify({
        type: 'attachment',
        sessionId: 's1',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><task-id>a1b2c3</task-id></task-notification>' },
      });
      expect(parseTranscriptLine(note)).not.toHaveProperty('handback');
    });
  });
});
