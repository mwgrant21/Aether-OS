import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidChatBody, runChatRequest, CHAT_MODEL } from './chatCore';

// Mock at the SDK boundary, same convention this repo already uses for
// other Anthropic-adjacent boundaries: never let a real network call
// happen from a unit test. mockCreate is declared via vi.hoisted so it's
// available inside the vi.mock factory despite normal TDZ ordering.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('isValidChatBody', () => {
  it('accepts a well-formed body', () => {
    expect(isValidChatBody({ system: 'you are X', messages: [{ role: 'user', text: 'hi' }] })).toBe(true);
  });

  it('rejects a missing system field', () => {
    expect(isValidChatBody({ messages: [{ role: 'user', text: 'hi' }] })).toBe(false);
  });

  it('rejects a non-string system field', () => {
    expect(isValidChatBody({ system: 42, messages: [{ role: 'user', text: 'hi' }] })).toBe(false);
  });

  it('rejects an empty messages array', () => {
    expect(isValidChatBody({ system: 'x', messages: [] })).toBe(false);
  });

  it('rejects a malformed turn (bad role)', () => {
    expect(isValidChatBody({ system: 'x', messages: [{ role: 'system', text: 'hi' }] })).toBe(false);
  });

  it('rejects a turn with a non-string text field', () => {
    expect(isValidChatBody({ system: 'x', messages: [{ role: 'user', text: 42 }] })).toBe(false);
  });

  it('rejects a completely malformed body (null, array, primitive)', () => {
    expect(isValidChatBody(null)).toBe(false);
    expect(isValidChatBody([])).toBe(false);
    expect(isValidChatBody('nope')).toBe(false);
  });
});

describe('runChatRequest', () => {
  it('returns a 400 when the body fails validation, without needing an API key', async () => {
    const result = await runChatRequest({ system: 'x' }, 'some-key');
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'body must be { system: string, messages: {role, text}[] }',
    });
  });

  it('returns a 503 when no API key is configured, even for a valid body', async () => {
    const result = await runChatRequest(
      { system: 'you are X', messages: [{ role: 'user', text: 'hi' }] },
      undefined
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'ANTHROPIC_API_KEY is not set on the server',
    });
  });

  it('checks validation before the API key, so an invalid body is still a 400 with no key set', async () => {
    const result = await runChatRequest(null, undefined);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'body must be { system: string, messages: {role, text}[] }',
    });
  });

  describe('model parameterization', () => {
    beforeEach(() => {
      mockCreate.mockReset();
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('defaults to CHAT_MODEL when no override is passed', async () => {
      await runChatRequest({ system: 'x', messages: [{ role: 'user', text: 'hi' }] }, 'some-key');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: CHAT_MODEL }));
    });

    it('uses the override model and maxTokens when passed', async () => {
      await runChatRequest({ system: 'x', messages: [{ role: 'user', text: 'hi' }] }, 'some-key', 'claude-haiku-4-5', 40);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-4-5', max_tokens: 40 }));
    });
  });
});
