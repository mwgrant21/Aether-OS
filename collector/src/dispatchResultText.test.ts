import { describe, it, expect } from 'vitest';
import { extractDispatchResultText } from './dispatchResultText.js';

function rawLine(content: unknown, toolUseId = 'tu_1'): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-07-08T09:00:00Z',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

describe('extractDispatchResultText', () => {
  it('extracts a plain string tool_result content', () => {
    const result = extractDispatchResultText(rawLine('Implemented the feature, all tests passing.'), 'tu_1');
    expect(result).toBe('Implemented the feature, all tests passing.');
  });

  it('extracts and joins text blocks from an array-shaped tool_result content', () => {
    const line = rawLine([
      { type: 'text', text: 'First finding.' },
      { type: 'text', text: 'Second finding.' },
    ]);
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBe('First finding.\nSecond finding.');
  });

  it('ignores non-text blocks when joining an array-shaped content', () => {
    const line = rawLine([
      { type: 'text', text: 'Kept.' },
      { type: 'image', source: { data: 'irrelevant' } },
    ]);
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBe('Kept.');
  });

  it('returns null when no tool_result matches the given toolUseId', () => {
    const result = extractDispatchResultText(rawLine('some content', 'tu_other'), 'tu_1');
    expect(result).toBeNull();
  });

  it('returns null when the message has no tool_result at all', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBeNull();
  });

  it('returns null for empty or whitespace-only content', () => {
    expect(extractDispatchResultText(rawLine(''), 'tu_1')).toBeNull();
    expect(extractDispatchResultText(rawLine('   '), 'tu_1')).toBeNull();
  });

  it('never throws on malformed JSON', () => {
    expect(() => extractDispatchResultText('not json at all {{', 'tu_1')).not.toThrow();
    expect(extractDispatchResultText('not json at all {{', 'tu_1')).toBeNull();
  });

  it('never throws on a well-formed but unexpected shape', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'not an array' } });
    expect(() => extractDispatchResultText(line, 'tu_1')).not.toThrow();
    expect(extractDispatchResultText(line, 'tu_1')).toBeNull();
  });
});
