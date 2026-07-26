import { describe, it, expect } from 'vitest';
import {
  detectReReadLoop,
  detectWriteDeleteRewrite,
  detectZeroEditBurn,
  detectStalledPermission,
  detectAnomalies,
} from './anomalyDetectors';
import { type ClosedToolCall } from '../../electron/toolCallHistory';
import { type RealActiveWork } from '../state/liveAgentsMath';

describe('anomalyDetectors', () => {
  describe('detectReReadLoop', () => {
    it('detects 3+ reads of same file', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'read-2',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 2000,
          closedAt: 2100,
        },
        {
          toolUseId: 'read-3',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 3000,
          closedAt: 3100,
        },
      ];

      const anomalies = detectReReadLoop(events);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe('reReadLoop');
      expect(anomalies[0].toolUseId).toBe('read-3'); // most recent
      expect(anomalies[0].detail).toContain('/src/index.ts');
      expect(anomalies[0].detail).toContain('3 times');
    });

    it('does not detect 2 reads (below threshold)', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'read-2',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 2000,
          closedAt: 2100,
        },
      ];

      const anomalies = detectReReadLoop(events);

      expect(anomalies).toHaveLength(0);
    });

    it('ignores reads with null filePath', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: null,
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'read-2',
          toolName: 'Read',
          filePath: null,
          startedAt: 2000,
          closedAt: 2100,
        },
        {
          toolUseId: 'read-3',
          toolName: 'Read',
          filePath: null,
          startedAt: 3000,
          closedAt: 3100,
        },
      ];

      const anomalies = detectReReadLoop(events);

      expect(anomalies).toHaveLength(0);
    });
  });

  describe('detectWriteDeleteRewrite', () => {
    it('detects 3+ writes/edits of same file within 5min window', () => {
      const nowMs = 10000;
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'write-1',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 5000,
          closedAt: 5100,
        },
        {
          toolUseId: 'edit-1',
          toolName: 'Edit',
          filePath: '/src/config.ts',
          startedAt: 6000,
          closedAt: 6100,
        },
        {
          toolUseId: 'write-2',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 7000,
          closedAt: 7100,
        },
      ];

      const anomalies = detectWriteDeleteRewrite(events, nowMs);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe('writeDeleteRewrite');
      expect(anomalies[0].toolUseId).toBe('write-2'); // most recent
      expect(anomalies[0].detail).toContain('/src/config.ts');
      expect(anomalies[0].detail).toContain('3 times');
      expect(anomalies[0].detail).toContain('5min');
    });

    it('does not detect 2 writes (below threshold)', () => {
      const nowMs = 10000;
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'write-1',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 5000,
          closedAt: 5100,
        },
        {
          toolUseId: 'write-2',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 6000,
          closedAt: 6100,
        },
      ];

      const anomalies = detectWriteDeleteRewrite(events, nowMs);

      expect(anomalies).toHaveLength(0);
    });

    it('ignores writes outside 5min window', () => {
      const nowMs = 400000; // far in the future
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'write-1',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 5000,
          closedAt: 5100, // 395000ms ago
        },
        {
          toolUseId: 'write-2',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 6000,
          closedAt: 6100,
        },
        {
          toolUseId: 'write-3',
          toolName: 'Write',
          filePath: '/src/config.ts',
          startedAt: 7000,
          closedAt: 7100,
        },
      ];

      const anomalies = detectWriteDeleteRewrite(events, nowMs);

      // Only the 2 most recent events are within the window
      expect(anomalies).toHaveLength(0);
    });
  });

  describe('detectZeroEditBurn', () => {
    it('detects high token usage with no file edits', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'bash-1',
          toolName: 'Bash',
          filePath: null,
          startedAt: 2000,
          closedAt: 2100,
        },
      ];
      const tokensUsed = 25000; // above 20000 threshold

      const anomalies = detectZeroEditBurn(events, tokensUsed);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe('zeroEditBurn');
      expect(anomalies[0].toolUseId).toBe('');
      expect(anomalies[0].detail).toContain('25000');
      expect(anomalies[0].detail).toContain('zero file edits');
    });

    it('does not trigger below 20000 tokens even with no edits', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
      ];
      const tokensUsed = 15000; // below 20000 threshold

      const anomalies = detectZeroEditBurn(events, tokensUsed);

      expect(anomalies).toHaveLength(0);
    });

    it('does not trigger if there is a Write', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'write-1',
          toolName: 'Write',
          filePath: '/src/output.ts',
          startedAt: 2000,
          closedAt: 2100,
        },
      ];
      const tokensUsed = 25000;

      const anomalies = detectZeroEditBurn(events, tokensUsed);

      expect(anomalies).toHaveLength(0);
    });

    it('does not trigger if there is an Edit', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'edit-1',
          toolName: 'Edit',
          filePath: '/src/output.ts',
          startedAt: 2000,
          closedAt: 2100,
        },
      ];
      const tokensUsed = 25000;

      const anomalies = detectZeroEditBurn(events, tokensUsed);

      expect(anomalies).toHaveLength(0);
    });

    it('does not trigger if there is a NotebookEdit', () => {
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'read-1',
          toolName: 'Read',
          filePath: '/src/index.ts',
          startedAt: 1000,
          closedAt: 1100,
        },
        {
          toolUseId: 'notebook-1',
          toolName: 'NotebookEdit',
          filePath: '/src/notebook.ipynb',
          startedAt: 2000,
          closedAt: 2100,
        },
      ];
      const tokensUsed = 25000;

      const anomalies = detectZeroEditBurn(events, tokensUsed);

      expect(anomalies).toHaveLength(0);
    });
  });

  describe('detectStalledPermission', () => {
    it('detects open work stalled for 60+ seconds with no result', () => {
      const nowMs = 100000;
      const openWork: RealActiveWork[] = [
        {
          toolUseId: 'agent-1',
          kind: 'agent',
          label: 'code-reviewer',
          description: 'Review PR',
          startedAt: new Date(nowMs - 70000).toISOString(), // 70 seconds ago
        },
      ];
      const events: ClosedToolCall[] = [];

      const anomalies = detectStalledPermission(openWork, events, nowMs);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].kind).toBe('stalledPermission');
      expect(anomalies[0].toolUseId).toBe('agent-1');
      expect(anomalies[0].detail).toContain('code-reviewer');
      expect(anomalies[0].detail).toContain('70s');
    });

    it('does not trigger if work closed before 60 seconds', () => {
      const nowMs = 100000;
      const openWork: RealActiveWork[] = [
        {
          toolUseId: 'agent-1',
          kind: 'agent',
          label: 'code-reviewer',
          description: 'Review PR',
          startedAt: new Date(nowMs - 30000).toISOString(), // 30 seconds ago
        },
      ];
      const events: ClosedToolCall[] = [];

      const anomalies = detectStalledPermission(openWork, events, nowMs);

      expect(anomalies).toHaveLength(0);
    });

    it('does not trigger if work has closed result', () => {
      const nowMs = 100000;
      const openWork: RealActiveWork[] = [
        {
          toolUseId: 'agent-1',
          kind: 'agent',
          label: 'code-reviewer',
          description: 'Review PR',
          startedAt: new Date(nowMs - 70000).toISOString(), // 70 seconds ago
        },
      ];
      const events: ClosedToolCall[] = [
        {
          toolUseId: 'agent-1',
          toolName: 'Agent',
          filePath: null,
          startedAt: nowMs - 70000,
          closedAt: nowMs - 10000, // Closed 10 seconds ago
        },
      ];

      const anomalies = detectStalledPermission(openWork, events, nowMs);

      expect(anomalies).toHaveLength(0);
    });
  });

  describe('detectAnomalies', () => {
    it('combines all detectors', () => {
      const nowMs = 100000;
      const history = {
        events: [
          // Re-read loop
          {
            toolUseId: 'read-1',
            toolName: 'Read',
            filePath: '/src/index.ts',
            startedAt: 1000,
            closedAt: 1100,
          },
          {
            toolUseId: 'read-2',
            toolName: 'Read',
            filePath: '/src/index.ts',
            startedAt: 2000,
            closedAt: 2100,
          },
          {
            toolUseId: 'read-3',
            toolName: 'Read',
            filePath: '/src/index.ts',
            startedAt: 3000,
            closedAt: 3100,
          },
          // Write-delete-rewrite (within 5min window)
          {
            toolUseId: 'write-1',
            toolName: 'Write',
            filePath: '/src/config.ts',
            startedAt: 90000,
            closedAt: 90100,
          },
          {
            toolUseId: 'edit-1',
            toolName: 'Edit',
            filePath: '/src/config.ts',
            startedAt: 91000,
            closedAt: 91100,
          },
          {
            toolUseId: 'write-2',
            toolName: 'Write',
            filePath: '/src/config.ts',
            startedAt: 92000,
            closedAt: 92100,
          },
        ] as ClosedToolCall[],
      };
      const work: RealActiveWork[] = [
        {
          toolUseId: 'agent-1',
          kind: 'agent',
          label: 'code-reviewer',
          description: 'Review PR',
          startedAt: new Date(nowMs - 70000).toISOString(), // 70 seconds ago
        },
      ];
      const tokensUsed = 25000;

      const anomalies = detectAnomalies(history, work, tokensUsed, nowMs);

      expect(anomalies.length).toBeGreaterThanOrEqual(3);
      const kinds = anomalies.map((a) => a.kind);
      expect(kinds).toContain('reReadLoop');
      expect(kinds).toContain('writeDeleteRewrite');
      expect(kinds).toContain('stalledPermission');
    });

    it('returns empty array when no anomalies detected', () => {
      const nowMs = 100000;
      const history = {
        events: [
          {
            toolUseId: 'read-1',
            toolName: 'Read',
            filePath: '/src/index.ts',
            startedAt: 1000,
            closedAt: 1100,
          },
          {
            toolUseId: 'write-1',
            toolName: 'Write',
            filePath: '/src/output.ts',
            startedAt: 2000,
            closedAt: 2100,
          },
        ] as ClosedToolCall[],
      };
      const work: RealActiveWork[] = [];
      const tokensUsed = 10000; // below threshold

      const anomalies = detectAnomalies(history, work, tokensUsed, nowMs);

      expect(anomalies).toHaveLength(0);
    });
  });
});
