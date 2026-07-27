import { describe, it, expect } from 'vitest';
import { computeCacheHitRate } from './cacheHitRate';
import { type TranscriptEvent } from '../../electron/transcriptParser';

function usageEvent(inputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens = 0): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: null,
    timestamp: new Date('2026-07-08T09:00:00Z'),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens, outputTokens: 0, cacheCreationInputTokens, cacheReadInputTokens },
    toolUses: [],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  };
}

describe('computeCacheHitRate', () => {
  it('returns 0 for no events', () => {
    expect(computeCacheHitRate([])).toBe(0);
  });

  it('returns 0 when every event has no usage', () => {
    const events: TranscriptEvent[] = [
      {
        kind: 'user',
        sessionId: null,
        timestamp: new Date(),
        cwd: null,
        model: null,
        usage: null,
        toolUses: [],
        toolResults: [],
        isHumanPrompt: false,
        humanText: null,
        originKind: null,
      },
    ];
    expect(computeCacheHitRate(events)).toBe(0);
  });

  it('computes cacheRead / (input + cacheRead), ignoring cacheCreationInputTokens', () => {
    const events = [usageEvent(100, 0, 500)];
    // input=100, cacheRead=0 -> 0 regardless of the 500 cacheCreation tokens.
    expect(computeCacheHitRate(events)).toBe(0);
  });

  it('sums across all events before dividing', () => {
    const events = [usageEvent(100, 0), usageEvent(0, 100)];
    // totalInput=100, totalCacheRead=100 -> 100 / 200 = 0.5
    expect(computeCacheHitRate(events)).toBe(0.5);
  });

  it('matches liveAgentTracker\'s formula shape for an all-cache-hit session', () => {
    const events = [usageEvent(0, 300)];
    expect(computeCacheHitRate(events)).toBe(1);
  });
});
