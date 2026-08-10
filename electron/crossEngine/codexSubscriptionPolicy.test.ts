// electron/crossEngine/codexSubscriptionPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { CHAT_GPT_AUTH_METHOD_ID, isAllowedAuthStatus, offersChatGptAuthMethod } from './codexSubscriptionPolicy';

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

describe('CHAT_GPT_AUTH_METHOD_ID', () => {
  it('is the exact wire id the real adapter advertises', () => {
    expect(CHAT_GPT_AUTH_METHOD_ID).toBe('chat-gpt');
  });
});

describe('offersChatGptAuthMethod', () => {
  it('accepts the real adapter response, which always also offers api-key', () => {
    expect(offersChatGptAuthMethod([{ id: 'api-key' }, { id: 'chat-gpt' }])).toBe(true);
  });

  it('refuses when only api-key is offered rather than falling back to it', () => {
    expect(offersChatGptAuthMethod([{ id: 'api-key' }])).toBe(false);
  });

  it('refuses when only a gateway is offered', () => {
    expect(offersChatGptAuthMethod([{ id: 'gateway' }])).toBe(false);
  });

  it('refuses an empty, missing, or non-array list', () => {
    expect(offersChatGptAuthMethod([])).toBe(false);
    expect(offersChatGptAuthMethod(null)).toBe(false);
    expect(offersChatGptAuthMethod(undefined)).toBe(false);
    expect(offersChatGptAuthMethod('chat-gpt' as never)).toBe(false);
  });

  it('refuses near-miss ids, including the device-code variant', () => {
    expect(offersChatGptAuthMethod([{ id: 'chat-gpt-device-code' }])).toBe(false);
    expect(offersChatGptAuthMethod([{ id: 'ChatGPT' }])).toBe(false);
    expect(offersChatGptAuthMethod([{ id: 'chat-gpt ' }])).toBe(false);
  });

  it('tolerates malformed entries without throwing', () => {
    expect(offersChatGptAuthMethod([null as never, { id: 'chat-gpt' }])).toBe(true);
    expect(offersChatGptAuthMethod([{}, { id: undefined }])).toBe(false);
  });
});
