import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseAccountRateLimits, asDepletionInput } from './codexRateLimits';

const AT = Date.UTC(2026, 8, 7, 12, 0, 0);

// Captured from a REAL `codex app-server` (codex-cli 0.153.2) response to
// `account/rateLimits/read`, 2026-09-07 -- no thread opened. The account id
// and the credit-grant id are redacted; everything else, including key
// order, is untouched. This is the shape real Codex actually sends: wrapped
// in `result.rateLimits`, all camelCase, with `windowDurationMins` -- not
// the snake_case shape the earlier tests below exercise, which real Codex
// never sends.
const REAL_FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'codexRateLimits.real.json');
const REAL_ENVELOPE = JSON.parse(fs.readFileSync(REAL_FIXTURE_PATH, 'utf8'));

describe('parseAccountRateLimits', () => {
  it('reads snake_case windows with an epoch-seconds reset', () => {
    const parsed = parseAccountRateLimits(
      {
        rate_limits: {
          primary: { used_percent: 42.5, window_minutes: 300, resets_at: AT / 1000 + 600 },
          secondary: { used_percent: 7, window_minutes: 10080, resets_at: AT / 1000 + 86400 },
        },
      },
      AT,
    );
    expect(parsed.primary).toEqual({ usedPercentage: 42.5, windowMinutes: 300, resetsAtMs: AT + 600_000 });
    expect(parsed.secondary).toEqual({ usedPercentage: 7, windowMinutes: 10080, resetsAtMs: AT + 86_400_000 });
    expect(parsed.capturedAtMs).toBe(AT);
  });

  it('reads camelCase windows at the top level, with no rateLimits envelope', () => {
    const parsed = parseAccountRateLimits(
      { primary: { usedPercent: 10, windowMinutes: 300, resetsInSeconds: 60 } },
      AT,
    );
    expect(parsed.primary).toEqual({ usedPercentage: 10, windowMinutes: 300, resetsAtMs: AT + 60_000 });
    expect(parsed.secondary).toBeNull();
  });

  it('accepts an ISO reset timestamp', () => {
    const parsed = parseAccountRateLimits(
      { primary: { usedPercentage: 1, resetsAt: '2026-09-07T13:00:00.000Z' } },
      AT,
    );
    expect(parsed.primary?.resetsAtMs).toBe(Date.UTC(2026, 8, 7, 13, 0, 0));
    expect(parsed.primary?.windowMinutes).toBeNull();
  });

  it('returns nulls rather than throwing on junk, an absent response, or a non-numeric percentage', () => {
    for (const raw of [null, undefined, 42, 'nope', [], { primary: { used_percent: 'lots' } }]) {
      const parsed = parseAccountRateLimits(raw, AT);
      expect(parsed.primary).toBeNull();
      expect(parsed.secondary).toBeNull();
      expect(parsed.capturedAtMs).toBe(AT);
    }
  });

  it('keeps a window whose reset time is unreadable, because the percentage is still usable', () => {
    const parsed = parseAccountRateLimits({ primary: { used_percent: 55, resets_at: 'never' } }, AT);
    expect(parsed.primary).toEqual({ usedPercentage: 55, windowMinutes: null, resetsAtMs: null });
  });

  it('reads windowDurationMins (the field the real codex app-server sends) as windowMinutes', () => {
    const parsed = parseAccountRateLimits(
      { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: AT / 1000 + 60 } },
      AT,
    );
    expect(parsed.primary?.windowMinutes).toBe(300);
  });

  it('accepts the snake_case windowDurationMins spelling too', () => {
    const parsed = parseAccountRateLimits(
      { primary: { used_percent: 5, window_duration_mins: 10080, resets_at: AT / 1000 + 60 } },
      AT,
    );
    expect(parsed.primary?.windowMinutes).toBe(10080);
  });

  it('parses a real captured account/rateLimits/read response (codex-cli 0.153.2, 2026-09-07)', () => {
    const parsed = parseAccountRateLimits(REAL_ENVELOPE.result, AT);
    expect(parsed.primary).toEqual({
      usedPercentage: 0,
      windowMinutes: 300,
      resetsAtMs: 1788852721000,
    });
    expect(parsed.secondary).toEqual({
      usedPercentage: 16,
      windowMinutes: 10080,
      resetsAtMs: 1789105883000,
    });
  });
});

describe('asDepletionInput', () => {
  it('maps the primary window onto the shape deriveDepletion consumes', () => {
    const parsed = parseAccountRateLimits(
      { primary: { used_percent: 40, window_minutes: 300, resets_at: AT / 1000 + 1800 } },
      AT,
    );
    expect(asDepletionInput(parsed)).toEqual({
      capturedAtMs: AT,
      fiveHour: { usedPercentage: 40, resetsAtMs: AT + 1_800_000 },
    });
  });

  it('yields a null window when the primary reset time is unknown, since a projection needs one', () => {
    const parsed = parseAccountRateLimits({ primary: { used_percent: 40 } }, AT);
    expect(asDepletionInput(parsed).fiveHour).toBeNull();
  });

  it('picks the 5-hour window by windowMinutes rather than position when the server swaps them', () => {
    const parsed = parseAccountRateLimits(
      {
        // primary/secondary reversed from the usual convention.
        primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: AT / 1000 + 86400 },
        secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: AT / 1000 + 1800 },
      },
      AT,
    );
    expect(asDepletionInput(parsed)).toEqual({
      capturedAtMs: AT,
      fiveHour: { usedPercentage: 40, resetsAtMs: AT + 1_800_000 },
    });
  });

  it('falls back to positional primary when neither window reports windowMinutes', () => {
    const parsed = parseAccountRateLimits(
      { primary: { used_percent: 40, resets_at: AT / 1000 + 1800 }, secondary: { used_percent: 7, resets_at: AT / 1000 + 86400 } },
      AT,
    );
    expect(asDepletionInput(parsed).fiveHour).toEqual({ usedPercentage: 40, resetsAtMs: AT + 1_800_000 });
  });

  it('maps the real fixture onto the 5-hour window via the confirmed 300-minute mapping', () => {
    const parsed = parseAccountRateLimits(REAL_ENVELOPE.result, AT);
    expect(asDepletionInput(parsed)).toEqual({
      capturedAtMs: AT,
      fiveHour: { usedPercentage: 0, resetsAtMs: 1788852721000 },
    });
  });
});
