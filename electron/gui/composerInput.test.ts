// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { frameComposerInput } from './composerInput';
import { GUI_MAX_COMPOSER_CHARS } from './guiTypes';

describe('frameComposerInput', () => {
  it('frames a single line as text plus CR in one write', () => {
    expect(frameComposerInput('hello')).toEqual({ ok: true, writes: ['hello\r'] });
  });
  it('frames multi-line text as a bracketed paste then a separate Enter', () => {
    expect(frameComposerInput('a\nb')).toEqual({ ok: true, writes: ['\x1b[200~a\nb\x1b[201~', '\r'] });
  });
  it('strips ESC so a paste terminator cannot be smuggled', () => {
    const r = frameComposerInput('a\x1b[201~b');
    expect(r).toEqual({ ok: true, writes: ['a[201~b\r'] });
    expect(JSON.stringify(r)).not.toContain('\u001b');
  });
  it('normalises CRLF and lone CR to newlines', () => {
    expect(frameComposerInput('a\r\nb\rc')).toEqual({ ok: true, writes: ['\x1b[200~a\nb\nc\x1b[201~', '\r'] });
  });
  it('rejects empty and whitespace-only input', () => {
    expect(frameComposerInput('')).toEqual({ ok: false });
    expect(frameComposerInput(' \n\t \x1b')).toEqual({ ok: false });
  });
  it('rejects input over the cap and accepts exactly the cap', () => {
    expect(frameComposerInput('x'.repeat(GUI_MAX_COMPOSER_CHARS + 1))).toEqual({ ok: false });
    expect(frameComposerInput('x'.repeat(GUI_MAX_COMPOSER_CHARS)).ok).toBe(true);
  });
  it('keeps tabs', () => {
    expect(frameComposerInput('a\tb')).toEqual({ ok: true, writes: ['a\tb\r'] });
  });
});
