import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendChannelMessage, loadChannelMessages, MAX_MESSAGES_PER_CHANNEL, saveChannelMessages } from './chatPersistence';
import type { ChatMessage } from './chatPersistence';

beforeEach(() => {
  localStorage.clear();
});

function msg(text: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id: `${text}-${Math.random()}`, role, text, t: '00:00' };
}

describe('chatPersistence', () => {
  it('round-trips messages through a per-channel localStorage key', () => {
    saveChannelMessages('AETHER', [msg('hello'), msg('hi there', 'assistant')]);
    const loaded = loadChannelMessages('AETHER');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe('hello');
  });

  it("keeps channels independent — one channel's history does not leak into another", () => {
    saveChannelMessages('AETHER', [msg('a')]);
    saveChannelMessages('Code Builder', [msg('b')]);
    expect(loadChannelMessages('AETHER')).toHaveLength(1);
    expect(loadChannelMessages('Code Builder')).toHaveLength(1);
    expect(loadChannelMessages('AETHER')[0].text).toBe('a');
  });

  it('returns an empty array when nothing is stored for a channel', () => {
    expect(loadChannelMessages('Nobody')).toEqual([]);
  });

  it('returns an empty array on malformed JSON instead of throwing', () => {
    localStorage.setItem('aether-chat-AETHER', '{not json');
    expect(loadChannelMessages('AETHER')).toEqual([]);
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveChannelMessages('AETHER', [msg('x')])).not.toThrow();
    vi.restoreAllMocks();
  });

  it('appendChannelMessage caps history at 50, dropping the oldest first', () => {
    let history: ChatMessage[] = [];
    for (let i = 0; i < 55; i++) {
      history = appendChannelMessage('AETHER', history, msg(`m${i}`));
    }
    expect(history).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(history[0].text).toBe('m5');
    expect(history[49].text).toBe('m54');
    expect(loadChannelMessages('AETHER')).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
  });
});
