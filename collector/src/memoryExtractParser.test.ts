import { describe, it, expect } from 'vitest';
import { parseExtractorOutput } from './memoryExtractParser.js';

describe('parseExtractorOutput', () => {
  it('parses a clean JSON array with no wrapping', () => {
    const raw = '[{"op":"ADD","kind":"habit","content":"x"}]';
    const result = parseExtractorOutput(raw);
    expect(result.parseError).toBeNull();
    expect(result.ops).toEqual([{ op: 'ADD', kind: 'habit', content: 'x' }]);
  });

  it('parses an empty array as a valid, deliberate "nothing worth remembering" result', () => {
    const result = parseExtractorOutput('[]');
    expect(result.parseError).toBeNull();
    expect(result.ops).toEqual([]);
  });

  it('extracts a JSON array wrapped in markdown code fences', () => {
    const raw = 'Here is the result:\n```json\n[{"op":"TOUCH","id":1}]\n```\nDone.';
    const result = parseExtractorOutput(raw);
    expect(result.parseError).toBeNull();
    expect(result.ops).toEqual([{ op: 'TOUCH', id: 1 }]);
  });

  it('extracts a JSON array preceded and followed by prose with no code fence', () => {
    const raw = 'I looked at the run and found one thing worth noting: [{"op":"TOUCH","id":2}] -- that is all.';
    const result = parseExtractorOutput(raw);
    expect(result.parseError).toBeNull();
    expect(result.ops).toEqual([{ op: 'TOUCH', id: 2 }]);
  });

  it('sets parseError and returns an empty ops array for valid JSON that is not an array', () => {
    const result = parseExtractorOutput('{"op":"ADD"}');
    expect(result.parseError).toBe('not_an_array');
    expect(result.ops).toEqual([]);
  });

  it('sets parseError and returns an empty ops array for unparseable garbage', () => {
    const result = parseExtractorOutput('the model refused and wrote a paragraph instead.');
    expect(result.parseError).toBe('no_json_array_found');
    expect(result.ops).toEqual([]);
  });

  it('sets parseError for empty or whitespace-only output', () => {
    expect(parseExtractorOutput('').parseError).toBe('empty_output');
    expect(parseExtractorOutput('   \n  ').parseError).toBe('empty_output');
  });

  it('never throws on malformed bracket-looking text', () => {
    expect(() => parseExtractorOutput('[{"op": "ADD", "content": "unterminated')).not.toThrow();
    const result = parseExtractorOutput('[{"op": "ADD", "content": "unterminated');
    expect(result.parseError).not.toBeNull();
    expect(result.ops).toEqual([]);
  });
});
