import { describe, expect, it } from 'vitest';
import { askClaude, toRecentTurns } from './claudeClient';
import type { ChatMessage } from './chatPersistence';

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: text, role, text, t: '00:00' };
}

describe('askClaude', () => {
  it('is an unimplemented Phase 2 seam that always resolves to null in Phase 1', async () => {
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });

  it('never throws regardless of input, so the send-flow fallback is safe to await unconditionally', async () => {
    await expect(askClaude('', [])).resolves.toBeNull();
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
