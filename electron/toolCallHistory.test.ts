import { describe, it, expect } from 'vitest';
import { createEmptyHistory, updateHistory, HISTORY_MAX_EVENTS, type ToolCallHistory } from './toolCallHistory';
import { type TranscriptEvent } from './transcriptParser';

describe('toolCallHistory', () => {
  it('tool use with no result stays in openByToolUseId', () => {
    const history = createEmptyHistory();
    const event: TranscriptEvent = {
      kind: 'assistant',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:00Z'),
      cwd: '/test',
      model: 'claude-3',
      usage: null,
      toolUses: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/tmp/file.txt' },
        },
      ],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };

    const updated = updateHistory(history, [event], 1000);

    expect(updated.events).toHaveLength(0);
    expect(updated.openByToolUseId).toHaveProperty('tool-1');
    expect(updated.openByToolUseId['tool-1'].toolName).toBe('Read');
    expect(updated.openByToolUseId['tool-1'].filePath).toBe('/tmp/file.txt');
  });

  it('matching result closes tool use and moves to events', () => {
    let history = createEmptyHistory();

    // Open the tool use
    const openEvent: TranscriptEvent = {
      kind: 'assistant',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:00Z'),
      cwd: '/test',
      model: 'claude-3',
      usage: null,
      toolUses: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/tmp/file.txt' },
        },
      ],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };

    history = updateHistory(history, [openEvent], 1000);
    expect(history.openByToolUseId).toHaveProperty('tool-1');
    expect(history.events).toHaveLength(0);

    // Close the tool use
    const closeEvent: TranscriptEvent = {
      kind: 'user',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:10Z'),
      cwd: '/test',
      model: null,
      usage: null,
      toolUses: [],
      toolResults: [{ toolUseId: 'tool-1' }],
      isHumanPrompt: false,
      humanText: null,
    };

    history = updateHistory(history, [closeEvent], 1000);

    expect(history.events).toHaveLength(1);
    expect(history.openByToolUseId).not.toHaveProperty('tool-1');
    expect(history.events[0].toolUseId).toBe('tool-1');
    expect(history.events[0].toolName).toBe('Read');
    expect(history.events[0].filePath).toBe('/tmp/file.txt');
    expect(history.events[0].startedAt).toBe(new Date('2026-07-26T12:00:00Z').getTime());
    expect(history.events[0].closedAt).toBe(new Date('2026-07-26T12:00:10Z').getTime());
  });

  it('filePath extracted from input.file_path when present, null when absent', () => {
    const history = createEmptyHistory();

    // With file_path
    const withPath: TranscriptEvent = {
      kind: 'assistant',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:00Z'),
      cwd: '/test',
      model: 'claude-3',
      usage: null,
      toolUses: [
        {
          id: 'tool-with-path',
          name: 'Read',
          input: { file_path: '/path/to/file.ts' },
        },
      ],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };

    // Without file_path
    const noPath: TranscriptEvent = {
      kind: 'assistant',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:00Z'),
      cwd: '/test',
      model: 'claude-3',
      usage: null,
      toolUses: [
        {
          id: 'tool-no-path',
          name: 'Bash',
          input: { command: 'ls -la' },
        },
      ],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };

    let updated = updateHistory(history, [withPath], 1000);
    expect(updated.openByToolUseId['tool-with-path'].filePath).toBe('/path/to/file.ts');

    updated = updateHistory(updated, [noPath], 1000);
    expect(updated.openByToolUseId['tool-no-path'].filePath).toBeNull();
  });

  it('buffer eviction: trim to HISTORY_MAX_EVENTS keeping newest', () => {
    let history = createEmptyHistory();

    // Create 510 events (beyond the 500 limit)
    for (let i = 0; i < 510; i++) {
      const openEvent: TranscriptEvent = {
        kind: 'assistant',
        sessionId: 'session1',
        timestamp: new Date(new Date('2026-07-26T12:00:00Z').getTime() + i * 1000),
        cwd: '/test',
        model: 'claude-3',
        usage: null,
        toolUses: [
          {
            id: `tool-${i}`,
            name: 'Read',
            input: {},
          },
        ],
        toolResults: [],
        isHumanPrompt: false,
        humanText: null,
      };

      const closeEvent: TranscriptEvent = {
        kind: 'user',
        sessionId: 'session1',
        timestamp: new Date(new Date('2026-07-26T12:00:00Z').getTime() + i * 1000 + 100),
        cwd: '/test',
        model: null,
        usage: null,
        toolUses: [],
        toolResults: [{ toolUseId: `tool-${i}` }],
        isHumanPrompt: false,
        humanText: null,
      };

      history = updateHistory(history, [openEvent, closeEvent], 1000);
    }

    expect(history.events).toHaveLength(HISTORY_MAX_EVENTS);
    // Check that the oldest events are gone and we have the newest 500
    const firstEvent = history.events[0];
    const lastEvent = history.events[history.events.length - 1];
    expect(firstEvent.toolUseId).toBe('tool-10'); // 0-9 are gone
    expect(lastEvent.toolUseId).toBe('tool-509');
  });

  it('multiple concurrent opens tracked independently', () => {
    let history = createEmptyHistory();

    // Open multiple tools at once
    const multiOpenEvent: TranscriptEvent = {
      kind: 'assistant',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:00Z'),
      cwd: '/test',
      model: 'claude-3',
      usage: null,
      toolUses: [
        { id: 'read-1', name: 'Read', input: { file_path: '/file1.ts' } },
        { id: 'write-1', name: 'Write', input: { file_path: '/file2.ts' } },
        { id: 'bash-1', name: 'Bash', input: { command: 'npm test' } },
      ],
      toolResults: [],
      isHumanPrompt: false,
      humanText: null,
    };

    history = updateHistory(history, [multiOpenEvent], 1000);

    expect(Object.keys(history.openByToolUseId)).toHaveLength(3);
    expect(history.openByToolUseId['read-1'].toolName).toBe('Read');
    expect(history.openByToolUseId['read-1'].filePath).toBe('/file1.ts');
    expect(history.openByToolUseId['write-1'].toolName).toBe('Write');
    expect(history.openByToolUseId['write-1'].filePath).toBe('/file2.ts');
    expect(history.openByToolUseId['bash-1'].toolName).toBe('Bash');
    expect(history.openByToolUseId['bash-1'].filePath).toBeNull();

    // Close one and verify others remain
    const partialCloseEvent: TranscriptEvent = {
      kind: 'user',
      sessionId: 'session1',
      timestamp: new Date('2026-07-26T12:00:10Z'),
      cwd: '/test',
      model: null,
      usage: null,
      toolUses: [],
      toolResults: [{ toolUseId: 'read-1' }],
      isHumanPrompt: false,
      humanText: null,
    };

    history = updateHistory(history, [partialCloseEvent], 1000);

    expect(history.events).toHaveLength(1);
    expect(history.openByToolUseId).not.toHaveProperty('read-1');
    expect(history.openByToolUseId).toHaveProperty('write-1');
    expect(history.openByToolUseId).toHaveProperty('bash-1');
  });
});
