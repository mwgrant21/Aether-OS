import { describe, expect, it } from 'vitest';
import { parseTranscriptLine, type TranscriptEvent } from '../../electron/transcriptParser';
import {
  applyLinesToOpenDispatches,
  applyLinesToOpenWork,
  detectCompletedDispatches,
  detectStartedDispatches,
  labelForToolUse,
  type RealAgentDispatch,
  type CompletedDispatchUsage,
  type RealActiveWork,
} from './liveAgentsMath';

// Fixtures are built as raw JSONL strings (matching real transcript shape)
// and run through the real parseTranscriptLine, so these tests exercise the
// actual parser contract rather than hand-rolled TranscriptEvent literals.
function parseLine(rawLine: string): TranscriptEvent {
  const event = parseTranscriptLine(rawLine);
  if (!event) throw new Error('expected a parseable line');
  return event;
}

function dispatchLine(
  id: string,
  subagentType: string,
  description: string,
  timestamp: string,
  prompt = '',
  model: string | null = null,
): TranscriptEvent {
  return parseLine(
    JSON.stringify({
      type: 'assistant',
      timestamp,
      message: {
        content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, description, prompt, model } }],
      },
    }),
  );
}

function completionLine(toolUseId: string, status = 'completed'): TranscriptEvent {
  return parseLine(
    JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary></task-notification>`,
      },
    }),
  );
}

function completionLineWithUsage(toolUseId: string, tokens: number, toolUses: number, durationMs: number, status = 'completed'): TranscriptEvent {
  return parseLine(
    JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary><usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage></task-notification>`,
      },
    }),
  );
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
    const queueLine = parseLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status></task-notification>',
      }),
    );
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), queueLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('does not treat an ordinary user message without origin.kind as a completion signal', () => {
    const plainUserLine = parseLine(JSON.stringify({ type: 'user', message: { content: 'just a normal reply' } }));
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), plainUserLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('ignores tool_use blocks with a name other than Agent', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-20T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } }] },
      }),
    );
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

  it('skips malformed JSON lines without throwing, and falls back to epoch for an unparsable timestamp', () => {
    const malformed = ['not json', '', '   '].map(parseTranscriptLine).filter((e): e is TranscriptEvent => e !== null);
    expect(() => applyLinesToOpenDispatches([], malformed)).not.toThrow();
    expect(applyLinesToOpenDispatches([], malformed)).toEqual([]);

    // A line that parses but carries an unparsable timestamp string upstream
    // (Invalid Date) must not throw out of isoOrEpoch's toISOString() call.
    const invalidTimestampLine = dispatchLine('tu_1', 'general-purpose', 'desc', 'not-a-real-timestamp');
    expect(() => applyLinesToOpenDispatches([], [invalidTimestampLine])).not.toThrow();
    expect(applyLinesToOpenDispatches([], [invalidTimestampLine])).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: new Date(0).toISOString(), prompt: '', model: null },
    ]);
  });

  it('continues from a non-empty currentOpen list (incremental tailing)', () => {
    const priorOpen: RealAgentDispatch[] = [
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ];
    const result = applyLinesToOpenDispatches(priorOpen, [completionLine('tu_1')]);
    expect(result).toEqual([]);
  });

  it('defaults subagentType, description, prompt, and model when input fields are missing', () => {
    const line = parseLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-20T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: {} }] },
      }),
    );
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

describe('detectStartedDispatches', () => {
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
    expect(detectStartedDispatches([tu1, tu2], [tu1, tu2])).toEqual([]);
  });

  it('returns the one dispatch that newly appeared', () => {
    expect(detectStartedDispatches([tu1], [tu1, tu2])).toEqual([tu2]);
  });

  it('returns multiple dispatches when several appear at once', () => {
    expect(detectStartedDispatches([], [tu1, tu2])).toEqual([tu1, tu2]);
  });

  it('returns an empty array when a dispatch is only removed, not added', () => {
    expect(detectStartedDispatches([tu1, tu2], [tu1])).toEqual([]);
  });

  it('separates a simultaneous add and remove correctly', () => {
    expect(detectStartedDispatches([tu1], [tu2])).toEqual([tu2]);
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
    const malformedLine = parseLine(
      JSON.stringify({
        type: 'user',
        origin: { kind: 'task-notification' },
        message: {
          content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status><summary>done</summary></task-notification>',
        },
      }),
    );
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

describe('labelForToolUse', () => {
  it('labels an Agent by subagent_type, falling back to description then "agent"', () => {
    expect(labelForToolUse('Agent', { subagent_type: 'general-purpose' })).toBe('general-purpose');
    expect(labelForToolUse('Agent', { description: 'Explore the repo' })).toBe('Explore the repo');
    expect(labelForToolUse('Agent', {})).toBe('agent');
  });

  it('labels a Bash call by its command', () => {
    expect(labelForToolUse('Bash', { command: 'npm test' })).toBe('npm test');
  });

  it('labels a file tool by the file basename, not the full path', () => {
    expect(labelForToolUse('Read', { file_path: 'C:\\proj\\src\\aggregator.js' })).toBe('aggregator.js');
    expect(labelForToolUse('Read', { file_path: '/proj/src/aggregator.js' })).toBe('aggregator.js');
  });

  it('labels a pattern-based tool by its pattern', () => {
    expect(labelForToolUse('Grep', { pattern: 'runningAgents' })).toBe('runningAgents');
  });

  it('falls back to the tool name for anything else', () => {
    expect(labelForToolUse('SomethingElse', {})).toBe('SomethingElse');
    expect(labelForToolUse('SomethingElse', null)).toBe('SomethingElse');
  });
});

function toolUseLine(id: string, name: string, input: Record<string, unknown>, timestamp: string): TranscriptEvent {
  return parseLine(
    JSON.stringify({
      type: 'assistant',
      timestamp,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    }),
  );
}

function toolResultLine(toolUseId: string): TranscriptEvent {
  return parseLine(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    }),
  );
}

describe('applyLinesToOpenWork', () => {
  it('tracks any in-flight tool call, not just Agent', () => {
    const lines = [
      toolUseLine('tu_bash', 'Bash', { command: 'npm test' }, '2026-07-24T10:00:00.000Z'),
      toolUseLine('tu_agent', 'Agent', { subagent_type: 'code-reviewer', description: 'verify' }, '2026-07-24T10:00:01.000Z'),
    ];
    const work = applyLinesToOpenWork([], lines);
    expect(work).toHaveLength(2);
    const bash = work.find((w) => w.toolUseId === 'tu_bash');
    const agent = work.find((w) => w.toolUseId === 'tu_agent');
    expect(bash).toMatchObject({ kind: 'tool', label: 'npm test' });
    expect(agent).toMatchObject({ kind: 'agent', label: 'code-reviewer', description: 'verify' });
  });

  it('closes a tool lane on a matching tool_result', () => {
    const lines = [
      toolUseLine('tu_bash', 'Bash', { command: 'npm test' }, '2026-07-24T10:00:00.000Z'),
      toolResultLine('tu_bash'),
    ];
    expect(applyLinesToOpenWork([], lines)).toEqual([]);
  });

  it('does not close an agent lane on a normal tool_result, only on task-notification', () => {
    const lines = [
      toolUseLine('tu_agent', 'Agent', { subagent_type: 'general-purpose', description: 'explore' }, '2026-07-24T10:00:00.000Z'),
      toolResultLine('tu_agent'),
    ];
    const work = applyLinesToOpenWork([], lines);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ toolUseId: 'tu_agent', kind: 'agent' });
  });

  it('closes an agent lane on a task-notification completion', () => {
    const lines = [
      toolUseLine('tu_agent', 'Agent', { subagent_type: 'general-purpose', description: 'explore' }, '2026-07-24T10:00:00.000Z'),
      completionLine('tu_agent'),
    ];
    expect(applyLinesToOpenWork([], lines)).toEqual([]);
  });

  it('continues from a non-empty currentOpen list (incremental tailing)', () => {
    const priorOpen: RealActiveWork[] = [{ toolUseId: 'tu_bash', kind: 'tool', label: 'npm test', description: '', startedAt: '2026-07-24T10:00:00.000Z' }];
    expect(applyLinesToOpenWork(priorOpen, [toolResultLine('tu_bash')])).toEqual([]);
  });

  it('skips malformed JSON lines without throwing', () => {
    const events = ['not json', '', '   '].map(parseTranscriptLine).filter((e): e is TranscriptEvent => e !== null);
    expect(() => applyLinesToOpenWork([], events)).not.toThrow();
  });
});
