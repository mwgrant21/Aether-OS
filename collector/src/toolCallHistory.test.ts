import { describe, it, expect } from 'vitest';
import { createEmptyHistory, updateHistory, toProjectRelative } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';

function assistantEvent(toolUseId: string, toolName: string, filePath: string | null, timestamp: Date, sessionId: string | null = null): TranscriptEvent {
  return {
    kind: 'assistant', sessionId, timestamp, cwd: null, model: null, usage: null,
    toolUses: [{ id: toolUseId, name: toolName, input: filePath ? { file_path: filePath } : {} }],
    toolResults: [], humanText: null, originKind: null,
  };
}

function userResultEvent(toolUseId: string, timestamp: Date, sessionId: string | null = null): TranscriptEvent {
  return {
    kind: 'user', sessionId, timestamp, cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId, resultLength: 10 }], humanText: null, originKind: null,
  };
}

describe('collector toolCallHistory', () => {
  it('opens a tool call on tool_use and closes it on the matching tool_result', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    const t1 = new Date('2026-07-28T00:00:01Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [assistantEvent('tu_1', 'Read', 'src/foo.ts', t0)], t0.getTime());
    expect(history.events).toEqual([]);
    expect(history.openByToolUseId['tu_1']).toEqual({ toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime(), subagentType: null, sessionId: null });

    history = updateHistory(history, [userResultEvent('tu_1', t1)], t1.getTime());
    expect(history.events).toEqual([
      { toolUseId: 'tu_1', toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime(), closedAt: t1.getTime() },
    ]);
    expect(history.openByToolUseId['tu_1']).toBeUndefined();
  });

  it('captures subagent_type from Agent tool_use input', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [{
      kind: 'assistant', sessionId: 'sess_123', timestamp: t0, cwd: null, model: null, usage: null,
      toolUses: [{ id: 'tu_agent', name: 'Agent', input: { subagent_type: 'general-purpose' } }],
      toolResults: [], humanText: null, originKind: null,
    }], t0.getTime());
    expect(history.openByToolUseId['tu_agent']).toEqual({
      toolName: 'Agent',
      filePath: null,
      startedAt: t0.getTime(),
      subagentType: 'general-purpose',
      sessionId: 'sess_123',
    });
  });

  it('leaves subagentType null when subagent_type is missing from input', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [{
      kind: 'assistant', sessionId: 'sess_456', timestamp: t0, cwd: null, model: null, usage: null,
      toolUses: [{ id: 'tu_read', name: 'Read', input: { file_path: 'src/foo.ts' } }],
      toolResults: [], humanText: null, originKind: null,
    }], t0.getTime());
    expect(history.openByToolUseId['tu_read']).toEqual({
      toolName: 'Read',
      filePath: 'src/foo.ts',
      startedAt: t0.getTime(),
      subagentType: null,
      sessionId: 'sess_456',
    });
  });

  it('captures sessionId for every tool_use regardless of tool name', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [{
      kind: 'assistant', sessionId: 'sess_789', timestamp: t0, cwd: null, model: null, usage: null,
      toolUses: [
        { id: 'tu_agent', name: 'Agent', input: { subagent_type: 'special-agent' } },
        { id: 'tu_edit', name: 'Edit', input: { file_path: 'test.ts' } },
      ],
      toolResults: [], humanText: null, originKind: null,
    }], t0.getTime());
    expect(history.openByToolUseId['tu_agent'].sessionId).toBe('sess_789');
    expect(history.openByToolUseId['tu_edit'].sessionId).toBe('sess_789');
  });

  it.runIf(process.platform === 'win32')(
    'rejects a cross-drive absolute path that relative() cannot make relative (Windows only)',
    () => {
      // On win32, path.relative() between paths on different drives returns
      // the unchanged absolute `to` path with no '..' segments, so the
      // traversal check alone would let this slip through un-rejected.
      const result = toProjectRelative(String.raw`D:\Secrets\Matt\x.ts`, String.raw`C:\Users\Matt\projects\foo`);
      expect(result).toBeNull();
    },
  );
});
