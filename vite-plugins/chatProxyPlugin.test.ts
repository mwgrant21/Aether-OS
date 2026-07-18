import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isValidChatBody, readRequestBody } from './chatProxyPlugin';

function fakeRequest(body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  return stream as unknown as IncomingMessage;
}

describe('readRequestBody', () => {
  it('collects a chunked request body into a single string', async () => {
    const result = await readRequestBody(fakeRequest('{"hello":"world"}'));
    expect(result).toBe('{"hello":"world"}');
  });

  it('resolves to an empty string for an empty body', async () => {
    const result = await readRequestBody(fakeRequest(''));
    expect(result).toBe('');
  });
});

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
