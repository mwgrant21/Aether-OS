import { describe, expect, it } from 'vitest';
import { applyLinesToOpenDispatches, type RealAgentDispatch } from './liveAgentsMath';

function dispatchLine(id: string, subagentType: string, description: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, description } }],
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

describe('applyLinesToOpenDispatches', () => {
  it('adds an open dispatch from an Agent tool_use line', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'Explore the repo', startedAt: '2026-07-20T10:00:00.000Z' },
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
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });

  it('does not treat an ordinary user message without origin.kind as a completion signal', () => {
    const plainUserLine = JSON.stringify({ type: 'user', message: { content: 'just a normal reply' } });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), plainUserLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z' },
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
      { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-20T10:00:05.000Z' },
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
    const priorOpen: RealAgentDispatch[] = [{ toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-20T10:00:00.000Z' }];
    const result = applyLinesToOpenDispatches(priorOpen, [completionLine('tu_1')]);
    expect(result).toEqual([]);
  });

  it('defaults subagentType and description when input fields are missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: {} }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([
      { toolUseId: 'tu_1', subagentType: 'agent', description: '', startedAt: '2026-07-20T10:00:00.000Z' },
    ]);
  });
});
