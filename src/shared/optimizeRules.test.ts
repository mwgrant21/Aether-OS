import { describe, it, expect } from 'vitest';
import { evaluateOptimizeRules, evaluateOptimizeRulesWithRecurrence, summarizeOptimize } from './optimizeRules';
import { type TranscriptEvent } from '../../electron/transcriptParser';

function opusTrivialEvent(i: number): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: null,
    timestamp: new Date(`2026-07-08T09:0${i}:00Z`),
    cwd: null,
    model: 'claude-opus-4-8',
    usage: { inputTokens: 50, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  };
}

function repeatedReadEvent(i: number, filePath = 'CLAUDE.md'): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: null,
    timestamp: new Date(`2026-07-08T10:0${i}:00Z`),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 },
    toolUses: [{ id: `r${filePath}${i}`, name: 'Read', input: { file_path: filePath } }],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  };
}

function uncappedBashEvent(): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: null,
    timestamp: new Date('2026-07-08T11:00:00Z'),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [{ id: 'b1', name: 'Bash', input: { command: 'cat build.log' } }],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  };
}

function bashResultEvent(toolUseId: string, resultLength: number): TranscriptEvent {
  return {
    kind: 'user',
    sessionId: null,
    timestamp: new Date('2026-07-08T11:00:01Z'),
    cwd: null,
    model: null,
    usage: null,
    toolUses: [],
    toolResults: [{ toolUseId, resultLength }],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  };
}

describe('optimizeRules', () => {
  it('flags Opus used on trivial (low-output) turns', () => {
    const events = [opusTrivialEvent(1), opusTrivialEvent(2), opusTrivialEvent(3)];
    const findings = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const finding = findings.find((f) => f.id === 'opus-on-trivial-turns');
    expect(finding).toBeTruthy();
    expect(finding!.estSavingsPerWeek).toBeGreaterThan(0);
  });

  it('flags the same file read repeatedly without a cache hit', () => {
    const events = [repeatedReadEvent(1), repeatedReadEvent(2), repeatedReadEvent(3)];
    const findings = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const finding = findings.find((f) => f.id === 'unpinned-config-re-reads');
    expect(finding).toBeTruthy();
    expect(finding!.detail).toMatch(/CLAUDE\.md/);
  });

  it('aggregates ALL offending files into one finding, not just the first', () => {
    const events = [
      repeatedReadEvent(1, 'CLAUDE.md'),
      repeatedReadEvent(2, 'CLAUDE.md'),
      repeatedReadEvent(3, 'CLAUDE.md'),
      repeatedReadEvent(4, 'config.json'),
      repeatedReadEvent(5, 'config.json'),
      repeatedReadEvent(6, 'config.json'),
    ];
    const findings = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const matching = findings.filter((f) => f.id === 'unpinned-config-re-reads');
    expect(matching.length).toBe(1);
    expect(matching[0].detail).toMatch(/CLAUDE\.md/);
    expect(matching[0].detail).toMatch(/config\.json/);
  });

  it('caps the listed files so a long list cannot blow up the UI', () => {
    const events: TranscriptEvent[] = [];
    for (let f = 0; f < 8; f++) {
      const name = `C:\\some\\dir\\file${f}.md`;
      events.push(repeatedReadEvent(1, name), repeatedReadEvent(2, name), repeatedReadEvent(3, name));
    }
    const findings = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const finding = findings.find((f) => f.id === 'unpinned-config-re-reads');
    expect(finding).toBeTruthy();
    // The full count is still reported...
    expect(finding!.detail).toMatch(/8 file/);
    // ...but the enumerated list is capped with a "+N more" summary, not all 8 paths.
    expect(finding!.detail).toMatch(/more/);
    const listed = [...Array(8).keys()].filter((f) => finding!.detail.includes(`file${f}.md`));
    expect(listed.length).toBeLessThanOrEqual(3);
    // Detail must not contain full Windows paths that explode the card.
    expect(finding!.detail.includes('C:\\some\\dir')).toBe(false);
  });

  it('flags uncapped bash output over the size threshold', () => {
    const events = [uncappedBashEvent(), bashResultEvent('b1', 20000)];
    const findings = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const finding = findings.find((f) => f.id === 'uncapped-bash-output');
    expect(finding).toBeTruthy();
  });

  it('produces no findings for a clean, well-behaved session', () => {
    const events: TranscriptEvent[] = [
      {
        kind: 'assistant',
        sessionId: null,
        timestamp: new Date(),
        cwd: null,
        model: 'claude-sonnet-4-6',
        usage: { inputTokens: 10, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        toolUses: [{ id: 'e1', name: 'Edit', input: {} }],
        toolResults: [],
        isHumanPrompt: false,
        humanText: null,
        originKind: null,
      },
    ];
    expect(evaluateOptimizeRules(events, 60 * 60 * 1000)).toEqual([]);
  });

  it('summarizeOptimize sums estSavingsPerWeek across findings', () => {
    const findings = [
      { estSavingsPerWeek: 3.5 },
      { estSavingsPerWeek: 4 },
      { estSavingsPerWeek: 1.25 },
    ] as any;
    expect(summarizeOptimize(findings).totalPerWeek).toBe(8.75);
  });

  it('summarizeOptimize empty findings -> total 0 and grade A', () => {
    expect(summarizeOptimize([])).toEqual({ totalPerWeek: 0, grade: 'A' });
  });

  it('evaluateOptimizeRulesWithRecurrence: no applied state -> passthrough, no recurring flag', () => {
    const events = [opusTrivialEvent(1), opusTrivialEvent(2), opusTrivialEvent(3)];
    const plain = evaluateOptimizeRules(events, 60 * 60 * 1000);
    const withState = evaluateOptimizeRulesWithRecurrence(events, 60 * 60 * 1000, {});
    expect(withState).toEqual(plain);
    expect(withState[0].recurring).toBeFalsy();
  });

  it('evaluateOptimizeRulesWithRecurrence: fix held (no events since appliedAt) -> finding dropped', () => {
    const events = [opusTrivialEvent(1), opusTrivialEvent(2), opusTrivialEvent(3)];
    const appliedAtMs = new Date('2026-07-08T09:04:00Z').getTime();
    const findings = evaluateOptimizeRulesWithRecurrence(events, 60 * 60 * 1000, {
      'opus-on-trivial-turns': appliedAtMs,
    });
    expect(findings.find((f) => f.id === 'opus-on-trivial-turns')).toBeUndefined();
  });

  it('evaluateOptimizeRulesWithRecurrence: recurs after appliedAt -> kept, tagged recurring, fresh numbers', () => {
    const events = [opusTrivialEvent(1), opusTrivialEvent(2), opusTrivialEvent(3)];
    const appliedAtMs = new Date('2026-07-08T09:01:30Z').getTime();
    const findings = evaluateOptimizeRulesWithRecurrence(events, 60 * 60 * 1000, {
      'opus-on-trivial-turns': appliedAtMs,
    });
    const finding = findings.find((f) => f.id === 'opus-on-trivial-turns');
    expect(finding).toBeTruthy();
    expect(finding!.recurring).toBe(true);
    expect(finding!.appliedAtMs).toBe(appliedAtMs);
    const freshOnly = evaluateOptimizeRules([opusTrivialEvent(2), opusTrivialEvent(3)], 60 * 60 * 1000);
    expect(finding!.estSavingsPerWeek).toBe(freshOnly.find((f) => f.id === 'opus-on-trivial-turns')!.estSavingsPerWeek);
  });

  it('evaluateOptimizeRulesWithRecurrence: findings never applied are unaffected by unrelated applied state', () => {
    const events = [repeatedReadEvent(1), repeatedReadEvent(2), repeatedReadEvent(3)];
    const appliedAtMs = new Date('2026-07-08T09:04:00Z').getTime();
    const findings = evaluateOptimizeRulesWithRecurrence(events, 60 * 60 * 1000, {
      'opus-on-trivial-turns': appliedAtMs,
    });
    const finding = findings.find((f) => f.id === 'unpinned-config-re-reads');
    expect(finding).toBeTruthy();
    expect(finding!.recurring).toBeFalsy();
  });
});
