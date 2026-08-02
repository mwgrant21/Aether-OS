import { describe, it, expect } from 'vitest';
import {
  createHeadlineThrottle,
  shouldCallForHeadline,
  recordHeadlineCall,
  createPeriodicContentCache,
  isNewPeriodicContent,
  formatHeadline,
} from './headlineGenerator';

const mockDispatch = { toolUseId: 't1', subagentType: 'general-purpose', description: 'refactor the reducer', prompt: '' };

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

describe('recordHeadlineCall', () => {
  it('marks the periodic throttle slot as consumed, so a periodic call right after is denied', () => {
    const throttle = createHeadlineThrottle();
    recordHeadlineCall(throttle, 't1', 1000);
    expect(shouldCallForHeadline(throttle, 't1', 'periodic', 1001)).toBe(false);
  });

  it('does not affect throttling for a different toolUseId', () => {
    const throttle = createHeadlineThrottle();
    recordHeadlineCall(throttle, 't1', 1000);
    expect(shouldCallForHeadline(throttle, 't2', 'periodic', 1001)).toBe(true);
  });
});

describe('isNewPeriodicContent / createPeriodicContentCache', () => {
  it('treats content as new the first time a toolUseId is seen', () => {
    const cache = createPeriodicContentCache();
    expect(isNewPeriodicContent(cache, 't1', 'npm install')).toBe(true);
  });

  it('treats identical content on a later call as not new', () => {
    const cache = createPeriodicContentCache();
    isNewPeriodicContent(cache, 't1', 'npm install');
    expect(isNewPeriodicContent(cache, 't1', 'npm install')).toBe(false);
  });

  it('treats changed content as new again', () => {
    const cache = createPeriodicContentCache();
    isNewPeriodicContent(cache, 't1', 'npm install');
    expect(isNewPeriodicContent(cache, 't1', 'npm test')).toBe(true);
  });

  it('tracks content independently per toolUseId', () => {
    const cache = createPeriodicContentCache();
    isNewPeriodicContent(cache, 't1', 'npm install');
    expect(isNewPeriodicContent(cache, 't2', 'npm install')).toBe(true);
  });
});

describe('formatHeadline', () => {
  it('uses activeWorkContext for the periodic trigger when provided', () => {
    expect(formatHeadline(mockDispatch, 'periodic', null, 'npm install')).toBe('general-purpose: npm install');
  });

  it('falls back to dispatch.description when no activeWorkContext is provided', () => {
    expect(formatHeadline(mockDispatch, 'periodic', null)).toBe('general-purpose: refactor the reducer');
  });

  it('formats a readable label for a known blocked notification type, ignoring activeWorkContext', () => {
    expect(formatHeadline(mockDispatch, 'blocked', 'permission_prompt', 'some active work')).toBe(
      'general-purpose needs a permission decision'
    );
  });

  it('formats a readable label for the other known blocked notification type', () => {
    expect(formatHeadline(mockDispatch, 'blocked', 'agent_needs_input')).toBe('general-purpose is waiting for input');
  });

  it('falls back to a generic label for an unrecognized blocked notification type', () => {
    expect(formatHeadline(mockDispatch, 'blocked', 'something_else')).toBe('general-purpose is blocked');
  });

  it('falls back to a generic label when blockingContext is null on a blocked trigger', () => {
    expect(formatHeadline(mockDispatch, 'blocked', null)).toBe('general-purpose is blocked');
  });

  it('truncates a long headline to 70 characters with an ellipsis', () => {
    const longWork = 'a'.repeat(100);
    const result = formatHeadline(mockDispatch, 'periodic', null, longWork);
    expect(result.length).toBe(70);
    expect(result.endsWith('…')).toBe(true);
  });

  it('never throws and never returns an empty string, given only the required arguments', () => {
    const result = formatHeadline(mockDispatch, 'periodic', null);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
