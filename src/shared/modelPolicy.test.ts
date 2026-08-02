import { describe, it, expect } from 'vitest';
import { resolveModel, ALLOWED_MODELS, isModelCallAllowed } from './modelPolicy';

describe('resolveModel', () => {
  it('resolves the chat tier to the opus model', () => {
    expect(resolveModel('chat')).toBe('claude-opus-4-8');
  });
});

describe('ALLOWED_MODELS', () => {
  it('contains exactly the one model the app is allowed to call (headlines no longer call a model)', () => {
    expect([...ALLOWED_MODELS]).toEqual(['claude-opus-4-8']);
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
