import { describe, it, expect } from 'vitest';
import { pricingTierForModel, costForEvent } from './modelPricing';

describe('modelPricing', () => {
  describe('pricingTierForModel', () => {
    it('classifies model names into pricing tiers', () => {
      expect(pricingTierForModel('claude-opus-4-8')).toBe('opus');
      expect(pricingTierForModel('claude-sonnet-5')).toBe('sonnet');
      expect(pricingTierForModel('claude-haiku-4-5-20251001')).toBe('haiku');
      expect(pricingTierForModel('claude-fable-5')).toBe('sonnet');
      expect(pricingTierForModel(null)).toBe('sonnet');
    });

    it('performs case-insensitive matching', () => {
      expect(pricingTierForModel('CLAUDE-OPUS-4-8')).toBe('opus');
      expect(pricingTierForModel('Claude-Haiku-4-5')).toBe('haiku');
      expect(pricingTierForModel('SONNET')).toBe('sonnet');
    });

    it('returns sonnet as default for unknown model names', () => {
      expect(pricingTierForModel('unknown-model')).toBe('sonnet');
      expect(pricingTierForModel('')).toBe('sonnet');
    });
  });

  describe('costForEvent', () => {
    it('computes cost for an event with usage', () => {
      const event = {
        model: 'claude-sonnet-4-6',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      expect(cost).toBeGreaterThan(0);
      expect(Math.round(cost)).toBe(18); // 1M input @ $3 + 1M output @ $15 = $18
    });

    it('returns 0 cost for an event with no usage', () => {
      expect(costForEvent({ model: 'claude-sonnet-4-6', usage: null })).toBe(0);
    });

    it('handles null event gracefully', () => {
      expect(costForEvent(null as any)).toBe(0);
    });

    it('accounts for cache creation input tokens in input cost', () => {
      const event = {
        model: 'claude-sonnet-4-6',
        usage: { inputTokens: 500_000, outputTokens: 0, cacheCreationInputTokens: 500_000, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // (500k + 500k) / 1M * $3 = 1M / 1M * $3 = $3
      expect(Math.round(cost)).toBe(3);
    });

    it('applies cache read discount correctly', () => {
      const event = {
        model: 'claude-opus-4-8',
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 },
      };
      const cost = costForEvent(event);
      // (1M / 1M) * $15 (opus input rate) * 0.1 (cache discount) = $1.50
      expect(cost).toBeCloseTo(1.5, 5);
    });

    it('computes correct cost for haiku model', () => {
      const event = {
        model: 'claude-haiku-4-5-20251001',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // 1M input @ $0.8 + 1M output @ $4 = $4.80
      expect(cost).toBeCloseTo(4.8, 5);
    });

    it('computes correct cost for opus model', () => {
      const event = {
        model: 'claude-opus-4-8',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // 1M input @ $15 + 1M output @ $75 = $90
      expect(cost).toBeCloseTo(90, 5);
    });

    it('combines all token types in cost calculation', () => {
      const event = {
        model: 'claude-sonnet-4-6',
        usage: {
          inputTokens: 500_000,
          outputTokens: 100_000,
          cacheCreationInputTokens: 200_000,
          cacheReadInputTokens: 300_000,
        },
      };
      const cost = costForEvent(event);
      // Input: (500k + 200k) / 1M * $3 = $2.1
      // Cache read: (300k / 1M) * $3 * 0.1 = $0.09
      // Output: (100k / 1M) * $15 = $1.5
      // Total = $2.1 + $0.09 + $1.5 = $3.69
      expect(cost).toBeCloseTo(3.69, 5);
    });
  });
});
