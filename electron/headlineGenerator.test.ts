import { describe, it, expect, vi } from 'vitest';
import { createHeadlineThrottle, shouldCallForHeadline } from './headlineGenerator';

describe('shouldCallForHeadline', () => {
  it('allows the first periodic call for a toolUseId', () => {
    const throttle = createHeadlineThrottle();
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000)).toBe(true);
  });

  it('blocks a second periodic call within 15s for the same toolUseId', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000 + 14000)).toBe(false);
  });

  it('allows a periodic call again after 15s have elapsed', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1000 + 15001)).toBe(true);
  });

  it('does not throttle a different toolUseId', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't2', 'periodic', 1000)).toBe(true);
  });

  it('bypasses the throttle entirely for a blocked trigger, even immediately after a periodic call', () => {
    const throttle = createHeadlineThrottle();
    shouldCallForHeadline(throttle, 't1', 'periodic', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'blocked', 1001)).toBe(true);
  });
});
