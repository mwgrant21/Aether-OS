import { describe, expect, it } from 'vitest';
import { applyLinesToOpenDispatches, detectCompletedDispatches, type RealAgentDispatch, type CompletedDispatchUsage } from './liveAgentsMath';

function dispatchLine(
  id: string,
  subagentType: string,
  description: string,
  timestamp: string,
  prompt = '',
  model: string | null = null,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, description, prompt, model } }],
    },
  });
}

function completionLine(toolUseId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary></task-notification>`,
    },
  });
}

function completionLineWithUsage(toolUseId: string, tokens: number, toolUses: number, durationMs: number, status = 'completed'): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary><usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage></task-notification>`,
    },
  });
}

describe('applyLinesToOpenDispatches', () => {
  it('adds an open dispatch from an Agent tool_use line', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'Explore the repo', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('captures prompt and model when present in tool_use.input', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z', 'Explore the repo and report findings.', 'claude-haiku-4-5'),
    ];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      {
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        startedAt: '2026-07-20T10:00:00.000Z',
        prompt: 'Explore the repo and report findings.',
        model: 'claude-haiku-4-5',
      },
    ]);
  });

  it('removes a dispatch on a matching real task-notification completion', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'), completionLine('tu_1')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('removes a dispatch whose completion has status failed or killed, not just completed', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), completionLine('tu_1', 'failed')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('ignores queue-operation lines even when their content contains task-notification-shaped XML', () => {
    const queueLine = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status></task-notification>',
    });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), queueLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('does not treat an ordinary user message without origin.kind as a completion signal', () => {
    const plainUserLine = JSON.stringify({ type: 'user', message: { content: 'just a normal reply' } });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), plainUserLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('ignores tool_use blocks with a name other than Agent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([]);
  });

  it('leaves other open dispatches alone when only one of several completes', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'first', '2026-07-20T10:00:00.000Z'),
      dispatchLine('tu_2', 'Explore', 'second', '2026-07-20T10:00:05.000Z'),
      completionLine('tu_1'),
    ];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-20T10:00:05.000Z', prompt: '', model: null },
    ]);
  });

  it('is a safe no-op for a completion event whose tool-use-id is not currently open', () => {
    expect(applyLinesToOpenDispatches([], [completionLine('unknown_id')])).toEqual([]);
  });

  it('skips malformed JSON lines without throwing', () => {
    expect(() => applyLinesToOpenDispatches([], ['not json', '', '   '])).not.toThrow();
    expect(applyLinesToOpenDispatches([], ['not json', '', '   '])).toEqual([]);
  });

  it('continues from a non-empty currentOpen list (incremental tailing)', () => {
    const priorOpen: RealAgentDispatch[] = [
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ];
    const result = applyLinesToOpenDispatches(priorOpen, [completionLine('tu_1')]);
    expect(result).toEqual([]);
  });

  it('defaults subagentType, description, prompt, and model when input fields are missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: {} }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([
      { toolUseId: 'tu_1', subagentType: 'agent', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });
});

describe('detectCompletedDispatches', () => {
  const tu1: RealAgentDispatch = {
    toolUseId: 'tu_1',
    subagentType: 'general-purpose',
    description: 'first',
    startedAt: '2026-07-20T10:00:00.000Z',
    prompt: '',
    model: null,
  };
  const tu2: RealAgentDispatch = {
    toolUseId: 'tu_2',
    subagentType: 'Explore',
    description: 'second',
    startedAt: '2026-07-20T10:00:05.000Z',
    prompt: '',
    model: null,
  };

  it('returns an empty array when the two lists are identical', () => {
    expect(detectCompletedDispatches([tu1, tu2], [tu1, tu2])).toEqual([]);
  });

  it('returns the one dispatch that disappeared', () => {
    expect(detectCompletedDispatches([tu1, tu2], [tu2])).toEqual([tu1]);
  });

  it('returns multiple dispatches when several disappear at once', () => {
    expect(detectCompletedDispatches([tu1, tu2], [])).toEqual([tu1, tu2]);
  });

  it('returns an empty array when a dispatch is only added, not removed', () => {
    expect(detectCompletedDispatches([tu1], [tu1, tu2])).toEqual([]);
  });

  it('separates a simultaneous add and remove correctly', () => {
    expect(detectCompletedDispatches([tu1], [tu2])).toEqual([tu1]);
  });
});

describe('applyLinesToOpenDispatches — completedOut parameter', () => {
  it('is fully backward compatible: omitting completedOut behaves identically to before', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'), completionLine('tu_1')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('captures usage stats for a dispatch that opens and completes across two calls', () => {
    const openResult = applyLinesToOpenDispatches([], [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')]);
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches(openResult, [completionLineWithUsage('tu_1', 12345, 8, 194546)], completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      tokens: 12345,
      toolUses: 8,
      durationMs: 194546,
    });
  });

  it('captures usage stats for a dispatch that opens and completes within the same batch of lines', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'),
      completionLineWithUsage('tu_1', 500, 2, 1000),
    ];
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches([], lines, completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({ toolUseId: 'tu_1', tokens: 500, toolUses: 2, durationMs: 1000 });
  });

  it('defaults missing or malformed usage sub-fields to 0', () => {
    const malformedLine = JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status><summary>done</summary></task-notification>',
      },
    });
    const openResult = applyLinesToOpenDispatches([], [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z')]);
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches(openResult, [malformedLine], completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({ tokens: 0, toolUses: 0, durationMs: 0 });
  });

  it('does not push a completedOut entry for a completion event whose tool-use-id is not currently open', () => {
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches([], [completionLineWithUsage('unknown_id', 100, 1, 500)], completedOut);
    expect(completedOut).toEqual([]);
  });
});
