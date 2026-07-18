import { afterEach, describe, expect, it, vi } from 'vitest';
import { askClaude, toRecentTurns } from './claudeClient';
import type { ChatMessage } from './chatPersistence';

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: text, role, text, t: '00:00' };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askClaude', () => {
  it('returns the reply string on a successful proxy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: 'Hello, Operator.' }) }),
    );
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBe('Hello, Operator.');
  });

  it('posts { system, messages } as the request body to /api/chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: 'ok' }) });
    vi.stubGlobal('fetch', fetchMock);
    await askClaude('sys', [{ role: 'user', text: 'hi' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ system: 'sys', messages: [{ role: 'user', text: 'hi' }] }),
      }),
    );
  });

  it('resolves to null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) }));
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });

  it('resolves to null when the reply field is missing or empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: '' }) }));
    await expect(askClaude('system prompt', [])).resolves.toBeNull();
  });

  it('resolves to null on a network error, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(askClaude('', [])).resolves.toBeNull();
  });

  it('resolves to null on a malformed (non-JSON) response body, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });
});

describe('toRecentTurns', () => {
  it('keeps only user/assistant messages, dropping any reserved system entries', () => {
    const turns = toRecentTurns([msg('user', 'hi'), msg('system', 'internal note'), msg('assistant', 'hello')]);
    expect(turns).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
  });

  it('limits to the last 10 turns by default', () => {
    const messages = Array.from({ length: 15 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    const turns = toRecentTurns(messages);
    expect(turns).toHaveLength(10);
    expect(turns[0].text).toBe('m5');
    expect(turns[9].text).toBe('m14');
  });
});
