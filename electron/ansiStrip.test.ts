import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansiStrip';

describe('stripAnsi', () => {
  it('strips CSI sequences (colors, cursor movement)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips OSC sequences (window title, hyperlinks)', () => {
    expect(stripAnsi('\x1b]0;title\x07visible')).toBe('visible');
  });

  it('strips other escape sequences', () => {
    expect(stripAnsi('\x1bMreverse-index-visible')).toBe('reverse-index-visible');
  });

  it('strips C0 control characters but preserves newline, tab, and carriage return', () => {
    expect(stripAnsi('a\x00b\nc\td\re')).toBe('ab\nc\td\re');
  });

  it('returns an empty string for null or undefined input', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('plain text, no escapes')).toBe('plain text, no escapes');
  });
});
