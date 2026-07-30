import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createHeadlineThrottle,
  shouldCallForHeadline,
  recordHeadlineCall,
  createPeriodicContentCache,
  isNewPeriodicContent,
  generateHeadline,
} from './headlineGenerator';
import * as chatCore from '../src/shared/chatCore';

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

describe('generateHeadline activeWorkContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('appends activeWorkContext to the periodic prompt when provided', async () => {
    const spy = vi.spyOn(chatCore, 'runChatRequest').mockResolvedValue({ ok: true, reply: 'headline' } as any);
    await generateHeadline(mockDispatch, 'periodic', null, 'key', 'npm install');
    const call = spy.mock.calls[0][0] as any;
    expect(call.messages[0].text).toBe('general-purpose: refactor the reducer -- currently: npm install');
  });

  it('omits the activeWorkContext suffix when none is provided', async () => {
    const spy = vi.spyOn(chatCore, 'runChatRequest').mockResolvedValue({ ok: true, reply: 'headline' } as any);
    await generateHeadline(mockDispatch, 'periodic', null, 'key');
    const call = spy.mock.calls[0][0] as any;
    expect(call.messages[0].text).toBe('general-purpose: refactor the reducer');
  });

  it('ignores activeWorkContext for a blocked trigger (blockingContext still wins)', async () => {
    const spy = vi.spyOn(chatCore, 'runChatRequest').mockResolvedValue({ ok: true, reply: 'headline' } as any);
    await generateHeadline(mockDispatch, 'blocked', 'waiting on npm install approval', 'key', 'some active work');
    const call = spy.mock.calls[0][0] as any;
    expect(call.messages[0].text).toBe('waiting on npm install approval');
  });
});
