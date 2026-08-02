import { describe, it, expect } from 'vitest';
import { resolveModel, ALLOWED_MODELS, isModelCallAllowed } from './modelPolicy';

describe('resolveModel', () => {
  it('resolves the chat tier to the opus model', () => {
    expect(resolveModel('chat')).toBe('claude-opus-4-8');
  });

  it('resolves the headline tier to the haiku model', () => {
    expect(resolveModel('headline')).toBe('claude-haiku-4-5');
  });
});

describe('ALLOWED_MODELS', () => {
  it('contains exactly the two models the app is allowed to call', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
  });
});

describe('isModelCallAllowed', () => {
  it('permits calls only in API mode', () => {
    expect(isModelCallAllowed('API')).toBe(true);
  });

  it('blocks calls in Local mode (no detection cascade yet -- Stage 12)', () => {
    expect(isModelCallAllowed('Local')).toBe(false);
  });

  it('blocks calls in Off mode', () => {
    expect(isModelCallAllowed('Off')).toBe(false);
  });
});
