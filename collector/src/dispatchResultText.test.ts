import { describe, it, expect } from 'vitest';
import {
  extractDispatchResultText,
  extractDispatchTaskId,
  isHandbackStub,
  createHandbackReportStore,
  HANDBACK_REPORT_MAX_CHARS,
  HANDBACK_STORE_MAX_ENTRIES,
  HANDBACK_STORE_MAX_TOTAL_CHARS,
} from './dispatchResultText.js';

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

const STUB =
  'This agent\'s report was delivered to you as a message from "a97f700e2e359a28b" (its SubagentHandback call). Read it there; it is not repeated here.';

describe('extractDispatchTaskId', () => {
  it('extracts and trims the task id', () => {
    expect(extractDispatchTaskId(notificationText('x'))).toBe('a97f700e2e359a28b');
    expect(extractDispatchTaskId('<task-id>  abc  </task-id>')).toBe('abc');
  });
  it('returns null when absent, empty, or input is null', () => {
    expect(extractDispatchTaskId('<tool-use-id>t</tool-use-id>')).toBeNull();
    expect(extractDispatchTaskId('<task-id>  </task-id>')).toBeNull();
    expect(extractDispatchTaskId(null)).toBeNull();
  });
});

describe('isHandbackStub', () => {
  it('is true for the 147-char stub and a 151-char variant', () => {
    expect(STUB).toHaveLength(147);
    expect(isHandbackStub(STUB)).toBe(true);
    const variant = STUB + '    ';
    expect(variant).toHaveLength(151);
    expect(isHandbackStub(variant)).toBe(true);
  });
  it('is false for a long real report quoting the phrase, ordinary text, and empty', () => {
    expect(isHandbackStub('x'.repeat(5000) + ' delivered to you as a message from ')).toBe(false);
    expect(isHandbackStub('Implemented the feature.')).toBe(false);
    expect(isHandbackStub('')).toBe(false);
  });
});

describe('createHandbackReportStore', () => {
  it('supports put/get/delete/clear/size/totalChars', () => {
    const s = createHandbackReportStore();
    expect(s.get('nope')).toBeNull();
    s.put('a', 'hello');
    s.put('b', 'world!');
    expect(s.get('a')).toBe('hello');
    expect(s.get('a')).toBe('hello'); // get does not remove
    expect(s.size()).toBe(2);
    expect(s.totalChars()).toBe(11);
    s.delete('a');
    expect(s.get('a')).toBeNull();
    expect(s.totalChars()).toBe(6);
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.totalChars()).toBe(0);
  });

  it('truncates a report to the per-report cap', () => {
    const s = createHandbackReportStore();
    s.put('a', 'z'.repeat(20_000));
    expect(s.get('a')!.length).toBe(HANDBACK_REPORT_MAX_CHARS);
  });

  it('bounds entries, evicting the oldest', () => {
    const s = createHandbackReportStore();
    for (let i = 0; i < 40; i++) s.put(`id${i}`, 'r');
    expect(s.size()).toBe(HANDBACK_STORE_MAX_ENTRIES);
    for (let i = 0; i < 8; i++) expect(s.get(`id${i}`)).toBeNull();
    for (let i = 8; i < 40; i++) expect(s.get(`id${i}`)).toBe('r');
  });

  it('bounds total chars, evicting the oldest, even with a max-size entry alone', () => {
    const s = createHandbackReportStore();
    for (let i = 0; i < 10; i++) s.put(`id${i}`, 'x'.repeat(HANDBACK_REPORT_MAX_CHARS));
    expect(s.totalChars()).toBeLessThanOrEqual(HANDBACK_STORE_MAX_TOTAL_CHARS);
    expect(s.get('id0')).toBeNull();
    expect(s.get('id1')).toBeNull();
    expect(s.get('id9')).not.toBeNull();
    const solo = createHandbackReportStore();
    solo.put('only', 'x'.repeat(HANDBACK_REPORT_MAX_CHARS));
    expect(solo.get('only')).not.toBeNull();
  });

  it('re-put refreshes age and does not double count', () => {
    const s = createHandbackReportStore();
    for (let i = 0; i < 32; i++) s.put(`id${i}`, 'r');
    s.put('id0', 'rr');
    expect(s.totalChars()).toBe(31 + 2);
    s.put('new', 'r'); // evicts oldest, which is now id1, not id0
    expect(s.get('id0')).toBe('rr');
    expect(s.get('id1')).toBeNull();
  });
});
