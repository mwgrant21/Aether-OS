// electron/crossEngine/codexSubscriptionPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';

describe('isAllowedAuthStatus', () => {
  it('permits only chat-gpt', () => {
    expect(isAllowedAuthStatus('chat-gpt')).toBe(true);
  });

  it('blocks api-key, gateway, unauthenticated, unknown, null, and undefined', () => {
    expect(isAllowedAuthStatus('api-key')).toBe(false);
    expect(isAllowedAuthStatus('gateway')).toBe(false);
    expect(isAllowedAuthStatus('unauthenticated')).toBe(false);
    expect(isAllowedAuthStatus('unknown')).toBe(false);
    expect(isAllowedAuthStatus(null)).toBe(false);
    expect(isAllowedAuthStatus(undefined)).toBe(false);
  });

  it('blocks any string not exactly "chat-gpt", including near-misses', () => {
    expect(isAllowedAuthStatus('chat-gpt ' as never)).toBe(false);
    expect(isAllowedAuthStatus('ChatGPT' as never)).toBe(false);
  });
});
