import { describe, it, expect } from 'vitest';
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';

function assistantEvent(toolUseId: string, toolName: string, filePath: string | null, timestamp: Date): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: null, timestamp, cwd: null, model: null, usage: null,
    toolUses: [{ id: toolUseId, name: toolName, input: filePath ? { file_path: filePath } : {} }],
    toolResults: [], originKind: null,
  };
}

function userResultEvent(toolUseId: string, timestamp: Date): TranscriptEvent {
  return {
    kind: 'user', sessionId: null, timestamp, cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId, resultLength: 10 }], originKind: null,
  };
}

describe('collector toolCallHistory', () => {
  it('opens a tool call on tool_use and closes it on the matching tool_result', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    const t1 = new Date('2026-07-28T00:00:01Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [assistantEvent('tu_1', 'Read', 'src/foo.ts', t0)], t0.getTime());
    expect(history.events).toEqual([]);
    expect(history.openByToolUseId['tu_1']).toEqual({ toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime() });

    history = updateHistory(history, [userResultEvent('tu_1', t1)], t1.getTime());
    expect(history.events).toEqual([
      { toolUseId: 'tu_1', toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime(), closedAt: t1.getTime() },
    ]);
    expect(history.openByToolUseId['tu_1']).toBeUndefined();
  });
});
