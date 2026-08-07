import { describe, it, expect } from 'vitest';
import {
  pricingTierForModel,
  costForEvent,
  costBreakdownForEvent,
  PRICING_VERIFIED_AT,
  PRICING_PER_MILLION_TOKENS,
} from './modelPricing';

describe('modelPricing', () => {
  describe('PRICING_VERIFIED_AT', () => {
    it('parses as a valid date', () => {
      expect(Number.isNaN(Date.parse(PRICING_VERIFIED_AT))).toBe(false);
    });

    // A typo that pushes the stamp into the future would render as a confident
    // but impossible "verified on" line in the Ledger footer.
    it('is not in the future', () => {
      expect(Date.parse(PRICING_VERIFIED_AT)).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('pricingTierForModel', () => {
    it('classifies model names into pricing tiers', () => {
      expect(pricingTierForModel('claude-opus-4-8')).toBe('opus');
      expect(pricingTierForModel('claude-sonnet-5')).toBe('sonnet');
      expect(pricingTierForModel('claude-haiku-4-5-20251001')).toBe('haiku');
      expect(pricingTierForModel(null)).toBe('sonnet');
    });

    // Regression: these previously fell through to the sonnet default, billing a
    // $10 / $50 model at $3 / $15 with no error surfaced anywhere.
    it('classifies the fable and mythos families into their own tier', () => {
      expect(pricingTierForModel('claude-fable-5')).toBe('fable');
      expect(pricingTierForModel('claude-mythos-5')).toBe('fable');
      expect(pricingTierForModel('claude-mythos-preview')).toBe('fable');
    });

    it('performs case-insensitive matching', () => {
      expect(pricingTierForModel('CLAUDE-OPUS-4-8')).toBe('opus');
      expect(pricingTierForModel('Claude-Haiku-4-5')).toBe('haiku');
      expect(pricingTierForModel('SONNET')).toBe('sonnet');
      expect(pricingTierForModel('Claude-Fable-5')).toBe('fable');
    });

    it('returns sonnet as default for unknown model names', () => {
      expect(pricingTierForModel('unknown-model')).toBe('sonnet');
      expect(pricingTierForModel('')).toBe('sonnet');
    });
  });

  describe('PRICING_PER_MILLION_TOKENS', () => {
    // Pins the verified rates themselves. Without this, a future edit could
    // change a number and every cost assertion below would be updated to match
    // it -- the table would drift with nothing objecting.
    it('holds the rates verified on PRICING_VERIFIED_AT', () => {
      expect(PRICING_PER_MILLION_TOKENS).toEqual({
        opus: { input: 5, output: 25 },
        sonnet: { input: 3, output: 15 },
        haiku: { input: 1, output: 5 },
        fable: { input: 10, output: 50 },
      });
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

    it('prices cache creation tokens at the 1.25x cache-write multiplier', () => {
      const event = {
        model: 'claude-sonnet-4-6',
        usage: { inputTokens: 500_000, outputTokens: 0, cacheCreationInputTokens: 500_000, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // Input:       (500k / 1M) * $3         = $1.50
      // Cache write: (500k / 1M) * $3 * 1.25  = $1.875
      // Total = $3.375. Was $3.00 when cache writes were billed at 1.0x input.
      expect(cost).toBeCloseTo(3.375, 5);
    });

    // Guards the multiplier itself: a cache-write token must cost strictly more
    // than a plain input token, never the same.
    it('prices a cache-write token above a plain input token', () => {
      const usageShape = { outputTokens: 0, cacheReadInputTokens: 0 };
      const asInput = costForEvent({
        model: 'claude-sonnet-4-6',
        usage: { ...usageShape, inputTokens: 1_000_000, cacheCreationInputTokens: 0 },
      });
      const asCacheWrite = costForEvent({
        model: 'claude-sonnet-4-6',
        usage: { ...usageShape, inputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      });
      expect(asCacheWrite).toBeGreaterThan(asInput);
      expect(asCacheWrite / asInput).toBeCloseTo(1.25, 5);
    });

    it('applies cache read discount correctly', () => {
      const event = {
        model: 'claude-opus-4-8',
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 },
      };
      const cost = costForEvent(event);
      // (1M / 1M) * $5 (opus input rate) * 0.1 (cache discount) = $0.50
      expect(cost).toBeCloseTo(0.5, 5);
    });

    it('computes correct cost for haiku model', () => {
      const event = {
        model: 'claude-haiku-4-5-20251001',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // 1M input @ $1 + 1M output @ $5 = $6
      expect(cost).toBeCloseTo(6, 5);
    });

    it('computes correct cost for opus model', () => {
      const event = {
        model: 'claude-opus-4-8',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // 1M input @ $5 + 1M output @ $25 = $30. Was $90 against the stale
      // Opus 3 rates the table carried before verification.
      expect(cost).toBeCloseTo(30, 5);
    });

    it('computes correct cost for the fable tier', () => {
      const event = {
        model: 'claude-fable-5',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      const cost = costForEvent(event);
      // 1M input @ $10 + 1M output @ $50 = $60. Was $18 while fable fell
      // through to the sonnet default.
      expect(cost).toBeCloseTo(60, 5);
    });

    // costForEvent is defined as the sum of costBreakdownForEvent, so the
    // Ledger's session card can show a breakdown that provably adds up to the
    // total beside it. This pins that relationship rather than assuming it.
    it('equals the sum of costBreakdownForEvent for the same event', () => {
      for (const model of ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5']) {
        const event = {
          model,
          usage: { inputTokens: 123_456, outputTokens: 7_890, cacheCreationInputTokens: 45_678, cacheReadInputTokens: 901_234 },
        };
        const b = costBreakdownForEvent(event);
        expect(costForEvent(event)).toBeCloseTo(b.input + b.output + b.cacheCreation + b.cacheRead, 12);
      }
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
      // Input:       (500k / 1M) * $3         = $1.50
      // Cache write: (200k / 1M) * $3 * 1.25  = $0.75
      // Cache read:  (300k / 1M) * $3 * 0.1   = $0.09
      // Output:      (100k / 1M) * $15        = $1.50
      // Total = $3.84
      expect(cost).toBeCloseTo(3.84, 5);
    });
  });
});
