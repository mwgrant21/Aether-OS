import { describe, it, expect } from 'vitest';
import { parseStatuslinePayload } from './statuslinePayload';

describe('parseStatuslinePayload', () => {
  it('parses a full realistic payload correctly', () => {
    const payload = {
      session_id: 'sess-123',
      model: {
        id: 'claude-3-5-sonnet-20241022',
        display_name: 'Claude 3.5 Sonnet',
      },
      rate_limits: {
        '5-hour': {
          used_percentage: 45.5,
          resets_at: 1722100000,
        },
        '7-day': {
          used_percentage: 12.3,
          resets_at: 1722700000,
        },
      },
      context_window: {
        used_percentage: 23.4,
        context_window_size: 200000,
        current_usage: {
          input_tokens: 15000,
          output_tokens: 5000,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 2000,
        },
      },
      cost: {
        total_cost_usd: 0.0234,
      },
      workspace: {
        current_dir: '/home/user/project',
        project_dir: '/home/user/project',
      },
    };

    const result = parseStatuslinePayload(payload, 1722050000);

    expect(result).not.toBeNull();
    expect(result!.capturedAtMs).toBe(1722050000);
    expect(result!.sessionId).toBe('sess-123');
    expect(result!.modelId).toBe('claude-3-5-sonnet-20241022');
    expect(result!.modelDisplayName).toBe('Claude 3.5 Sonnet');
    expect(result!.fiveHour).not.toBeNull();
    expect(result!.fiveHour!.usedPercentage).toBe(45.5);
    expect(result!.fiveHour!.resetsAtMs).toBe(1722100000000);
    expect(result!.sevenDay).not.toBeNull();
    expect(result!.sevenDay!.usedPercentage).toBe(12.3);
    expect(result!.sevenDay!.resetsAtMs).toBe(1722700000000);
    expect(result!.contextUsedPercentage).toBe(23.4);
    expect(result!.contextWindowSize).toBe(200000);
    expect(result!.contextUsage).not.toBeNull();
    expect(result!.contextUsage!.inputTokens).toBe(15000);
    expect(result!.contextUsage!.outputTokens).toBe(5000);
    expect(result!.contextUsage!.cacheCreationInputTokens).toBe(1000);
    expect(result!.contextUsage!.cacheReadInputTokens).toBe(2000);
    expect(result!.totalCostUsd).toBe(0.0234);
    expect(result!.currentDir).toBe('/home/user/project');
    expect(result!.projectDir).toBe('/home/user/project');
  });

  it('converts resets_at from seconds to milliseconds', () => {
    const payload = {
      rate_limits: {
        '5-hour': {
          used_percentage: 50,
          resets_at: 1000,
        },
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).not.toBeNull();
    expect(result!.fiveHour!.resetsAtMs).toBe(1000000);
  });

  it('produces contextUsage: null when current_usage is null in the payload', () => {
    const payload = {
      context_window: {
        used_percentage: 50,
        context_window_size: 100000,
        current_usage: null,
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.contextUsedPercentage).toBe(50);
    expect(result!.contextWindowSize).toBe(100000);
    expect(result!.contextUsage).toBeNull();
  });

  it('returns both windows null when rate_limits key is missing', () => {
    const payload = {
      session_id: 'sess-abc',
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).toBeNull();
    expect(result!.sevenDay).toBeNull();
  });

  it('produces null for a rate limit window with used_percentage but no resets_at', () => {
    const payload = {
      rate_limits: {
        '5-hour': {
          used_percentage: 45,
        },
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).toBeNull();
  });

  it('produces null for a rate limit window with resets_at but no used_percentage', () => {
    const payload = {
      rate_limits: {
        '7-day': {
          resets_at: 1722700000,
        },
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.sevenDay).toBeNull();
  });

  it('returns null when raw is null', () => {
    const result = parseStatuslinePayload(null, 0);
    expect(result).toBeNull();
  });

  it('returns null when raw is a string', () => {
    const result = parseStatuslinePayload('not an object', 0);
    expect(result).toBeNull();
  });

  it('returns null when raw is a number', () => {
    const result = parseStatuslinePayload(42, 0);
    expect(result).toBeNull();
  });

  it('returns null when raw is an empty array', () => {
    const result = parseStatuslinePayload([], 0);
    expect(result).toBeNull();
  });

  it('returns null when raw is a non-empty array', () => {
    const result = parseStatuslinePayload(['item1', 'item2'], 0);
    expect(result).toBeNull();
  });

  it('ignores unknown extra top-level fields without error', () => {
    const payload = {
      session_id: 'sess-xyz',
      unknown_field: 'some value',
      another_unknown: 12345,
      deeply: {
        nested: {
          unknown: 'field',
        },
      },
    };

    const result = parseStatuslinePayload(payload, 1234567890);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-xyz');
    expect(result!.capturedAtMs).toBe(1234567890);
    expect(result!.fiveHour).toBeNull();
    expect(result!.sevenDay).toBeNull();
  });

  it('handles empty rate_limits object gracefully', () => {
    const payload = {
      rate_limits: {},
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).toBeNull();
    expect(result!.sevenDay).toBeNull();
  });

  it('handles empty context_window object gracefully', () => {
    const payload = {
      context_window: {},
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.contextUsedPercentage).toBeNull();
    expect(result!.contextWindowSize).toBeNull();
    expect(result!.contextUsage).toBeNull();
  });

  it('handles non-finite numbers (Infinity, -Infinity, NaN) by treating them as missing', () => {
    const payload = {
      rate_limits: {
        '5-hour': {
          used_percentage: Infinity,
          resets_at: 1000,
        },
      },
      context_window: {
        used_percentage: NaN,
        context_window_size: 100000,
      },
      cost: {
        total_cost_usd: -Infinity,
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).toBeNull();
    expect(result!.contextUsedPercentage).toBeNull();
    expect(result!.totalCostUsd).toBeNull();
  });

  it('handles malformed nested objects without throwing', () => {
    const payload = {
      model: 'not an object',
      rate_limits: 'not an object',
      context_window: [],
      cost: null,
      workspace: undefined,
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.modelId).toBeNull();
    expect(result!.modelDisplayName).toBeNull();
    expect(result!.fiveHour).toBeNull();
    expect(result!.contextUsedPercentage).toBeNull();
    expect(result!.totalCostUsd).toBeNull();
  });

  it('handles partial context_window.current_usage (missing some fields)', () => {
    const payload = {
      context_window: {
        current_usage: {
          input_tokens: 100,
          output_tokens: 50,
          // missing cache_creation_input_tokens and cache_read_input_tokens
        },
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.contextUsage).toBeNull();
  });

  it('handles rate limit window with non-numeric used_percentage', () => {
    const payload = {
      rate_limits: {
        '5-hour': {
          used_percentage: 'not a number',
          resets_at: 1000,
        },
      },
    };

    const result = parseStatuslinePayload(payload, 0);

    expect(result).not.toBeNull();
    expect(result!.fiveHour).toBeNull();
  });

  it('returns a valid snapshot with all nulls for an empty object', () => {
    const result = parseStatuslinePayload({}, 5000);

    expect(result).not.toBeNull();
    expect(result!.capturedAtMs).toBe(5000);
    expect(result!.sessionId).toBeNull();
    expect(result!.modelId).toBeNull();
    expect(result!.modelDisplayName).toBeNull();
    expect(result!.fiveHour).toBeNull();
    expect(result!.sevenDay).toBeNull();
    expect(result!.contextUsedPercentage).toBeNull();
    expect(result!.contextWindowSize).toBeNull();
    expect(result!.contextUsage).toBeNull();
    expect(result!.totalCostUsd).toBeNull();
    expect(result!.currentDir).toBeNull();
    expect(result!.projectDir).toBeNull();
  });
});
