import { describe, it, expect } from 'vitest';
import { extractDispatchResultText } from './dispatchResultText.js';

// Shaped after a real captured task-notification event's humanText: all
// tags concatenated in one string, <result> containing multi-line markdown.
function notificationText(resultBody: string): string {
  return (
    '<task-notification>\n' +
    '<task-id>a97f700e2e359a28b</task-id>\n' +
    '<tool-use-id>toolu_01NESNPGPYBESN4SrbugEy7K</tool-use-id>\n' +
    '<status>completed</status>\n' +
    '<summary>Agent "Explore src/state directory" finished</summary>\n' +
    `<result>${resultBody}</result>\n` +
    '<subagent_tokens>500</subagent_tokens>\n' +
    '<tool_uses>8</tool_uses>\n' +
    '<duration_ms>90000</duration_ms>\n' +
    '</task-notification>'
  );
}

describe('extractDispatchResultText', () => {
  it('extracts a single-line result body', () => {
    const result = extractDispatchResultText(notificationText('Implemented the feature, all tests passing.'));
    expect(result).toBe('Implemented the feature, all tests passing.');
  });

  it('extracts a multi-line markdown result body', () => {
    const body = '## Task 1 Complete\n\n**Status**: DONE\n\n**Commit SHA**: c9c406b';
    const result = extractDispatchResultText(notificationText(body));
    expect(result).toBe(body);
  });

  it('trims leading/trailing whitespace from the captured result', () => {
    const result = extractDispatchResultText(notificationText('  padded on both sides  '));
    expect(result).toBe('padded on both sides');
  });

  it('returns null when there is no <result> tag at all', () => {
    const text = '<task-notification>\n<tool-use-id>tu_1</tool-use-id>\n</task-notification>';
    expect(extractDispatchResultText(text)).toBeNull();
  });

  it('returns null for an empty or whitespace-only result body', () => {
    expect(extractDispatchResultText(notificationText(''))).toBeNull();
    expect(extractDispatchResultText(notificationText('   '))).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractDispatchResultText(null)).toBeNull();
  });

  it('returns null for a plain empty string', () => {
    expect(extractDispatchResultText('')).toBeNull();
  });

  it('never throws on text containing unbalanced or nested angle brackets', () => {
    const text = notificationText('a < b and c > d, plus <stray');
    expect(() => extractDispatchResultText(text)).not.toThrow();
  });
});
