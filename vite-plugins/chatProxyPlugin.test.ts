import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { readRequestBody } from './chatProxyPlugin';

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
