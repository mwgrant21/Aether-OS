import { describe, expect, it } from 'vitest';
import capture from '../__fixtures__/trust-prompt-capture.json';
import { createTrustPromptMatcher } from './trustPromptMatcher';

const captured = capture.chunks.map(chunk => chunk.data).join('');
const paint = capture.chunks[capture.chunks.length - 1].data;
const redraw = '\x1b[2J\x1b[H' + paint;
function ready() {
  const matcher = createTrustPromptMatcher(() => 42);
  matcher.ingest(captured);
  expect(matcher.state()).toEqual({ seenAt: 42, active: true });
  return matcher;
}

describe('bounded current trust prompt observation', () => {
  it('recognizes the sanitized real eight-chunk capture without a clock delay', () => {
    const matcher = createTrustPromptMatcher(() => 42);
    for (const chunk of capture.chunks) matcher.ingest(chunk.data);
    expect(matcher.state()).toEqual({ seenAt: 42, active: true });
  });
  it('accepts every split point, including CSI and OSC ST, and single-character delivery', () => {
    for (let i = 0; i <= captured.length; i++) {
      const matcher = createTrustPromptMatcher(() => 42);
      matcher.ingest(captured.slice(0, i));
      matcher.ingest(captured.slice(i));
      expect(matcher.state().active, `split ${i}`).toBe(true);
    }
    const matcher = createTrustPromptMatcher();
    for (const ch of captured) matcher.ingest(ch);
    expect(matcher.state().active).toBe(true);
  });
  it('keeps OSC BEL/ST metadata opaque and visible link text intact', () => {
    for (const end of ['\x07', '\x1b\\']) {
      const spoof = '\x1b[2J\x1b[H\x1b]8;id=No, exit;Yes, I trust this folder' + end + 'ordinary text';
      const matcher = createTrustPromptMatcher();
      for (const ch of spoof) matcher.ingest(ch);
      expect(matcher.state()).toEqual({ seenAt: null, active: false });
      matcher.ingest(captured.replaceAll('\x1b\\', end));
      expect(matcher.state().active).toBe(true);
    }
    const matcher = createTrustPromptMatcher();
    matcher.ingest(captured.replace('Security guide', '\x1b]8;;Security guide\x1b\\Other text'));
    expect(matcher.state().active).toBe(false);
  });
  it('rejects the discarded accumulated two-label algorithm (negative control)', () => {
    const text = 'Log: user quoted "No, exit" and "Yes, I trust this folder" yesterday.';
    const rejectedBaseline = (value: string) => value.includes('No, exit') && value.includes('Yes, I trust this folder');
    expect(rejectedBaseline(text)).toBe(true); // baseline demonstrably false-positive
    const matcher = createTrustPromptMatcher();
    matcher.ingest(text);
    expect(matcher.state()).toEqual({ seenAt: null, active: false });
    matcher.ingest('\x1b[2J\x1b[H' + text);
    expect(matcher.state().active).toBe(false);
  });
  it('requires the whole structure, not just options or warning', () => {
    for (const phrase of ['Accessing', 'Quick', "Claude", 'No,', 'Yes,', 'Security guide', 'Enter']) {
      const matcher = createTrustPromptMatcher();
      matcher.ingest(captured.replace(phrase, 'x'.repeat(phrase.length)));
      expect(matcher.state().active, phrase).toBe(false);
    }
    const plain = captured.replace(/\x1b\][^\x07]*?\x1b\\/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ');
    const matcher = createTrustPromptMatcher();
    matcher.ingest(plain);
    expect(matcher.state().active).toBe(false);
  });
  it.each(['\x1b[2J', '\x1b[3;1H\x1b[2K', '\x1b[16;1H\rResolved\x1b[K', '\x1b[16;28H\b!', '\x1b[19;1H$ shell', '\x1b[32;1H\n', '\x1b[1S'])('invalidates stale prompt after %j', output => {
    const matcher = ready();
    matcher.ingest(output);
    expect(matcher.state()).toEqual({ seenAt: 42, active: false });
  });
  it('can reactivate on complete redraw while keeping first historical timestamp', () => {
    const matcher = ready();
    matcher.ingest('\x1b[1S');
    matcher.ingest(paint); // no clear boundary after unsupported scroll
    expect(matcher.state()).toEqual({ seenAt: 42, active: false });
    matcher.ingest(redraw);
    expect(matcher.state()).toEqual({ seenAt: 42, active: true });
    matcher.ingest('\x1b[2J');
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(true);
  });
  it('keeps color, visibility, complete hidden OSC and bell decorations harmless', () => {
    const matcher = ready();
    matcher.ingest('\x1b[0m\x1b[?25h\x07\x1b]0;title\x07');
    expect(matcher.state().active).toBe(true);
  });
  it.each(['\x1b[', '\x1b]8;;unterminated', '\x1b[999999H', '\x1b[1;1;1H', '\x1b[4h', '\x1b[1;1H' + 'x'.repeat(161), '\x1b[' + '0'.repeat(10000), '\x1b]8;;' + 'x'.repeat(10000), '\x1bP' + 'x'.repeat(10000), '\x1b]broken\x1bX'])('fails closed for uncertain/overflow controls %j', output => {
    const matcher = ready();
    matcher.ingest(output);
    expect(matcher.state()).toEqual({ seenAt: 42, active: false });
    expect(matcher.state().active).toBe(false); // time/state calls cannot activate
  });
  it('requires fresh-session reset after overlong hidden controls', () => {
    const matcher = ready();
    matcher.ingest('\x1b]8;;' + 'x'.repeat(10000));
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(false);
    matcher.ingest('\x1b\\' + redraw);
    expect(matcher.state().active).toBe(false);
    matcher.reset();
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(true);
  });
  it('scrollback erase preserves visible evidence and cannot recover an unknown screen', () => {
    const matcher = ready();
    matcher.ingest('\x1b[3J');
    expect(matcher.state().active).toBe(true);
    matcher.ingest('\x1b[1S\x1b[3J' + paint);
    expect(matcher.state().active).toBe(false);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(true);
  });
  it('rejects overwritten paragraph and formerly blank prompt rows', () => {
    for (const row of [4, 6, 8, 9, 10, 12, 14, 17]) {
      const matcher = ready();
      matcher.ingest('\x1b[' + row + ';1Hunexpected output');
      expect(matcher.state().active).toBe(false);
    }
  });
  it.each(['界', '\u0301', '😀'])('rejects unsupported glyph width %j', glyph => {
    const matcher = ready();
    matcher.ingest(glyph);
    expect(matcher.state().active).toBe(false);
  });
  it.each(['\x18', '\x1a', '\x9c'])('invalidates cancelled opaque strings %j before following visible output', terminator => {
    for (const prefix of ['\x1b]0;title', '\x1b]0;' + 'x'.repeat(10000), '\x1bPpayload']) {
      const matcher = ready();
      matcher.ingest(prefix + terminator + '\rREPLACED\x07');
      expect(matcher.state().active).toBe(false);
    }
  });
  it('rejects concealment and persistent unknown modes despite clear-screen redraw', () => {
    for (const text of [captured.replace('Accessing', '\x1b[8mAccessing'), '\x1b[5;20r\x1b[?6h' + captured]) {
      const matcher = createTrustPromptMatcher();
      matcher.ingest(text);
      expect(matcher.state().active).toBe(false);
      matcher.ingest(redraw);
      expect(matcher.state().active).toBe(false);
      matcher.reset();
      matcher.ingest(captured);
      expect(matcher.state().active).toBe(true);
    }
  });
  it('uses physical geometry and invalidates unsupported resize', () => {
    const matcher = ready();
    matcher.ingest('\x1b[31;1H');
    expect(matcher.state().active).toBe(false);
    matcher.ingest(redraw);
    matcher.resize(80, 24);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(false);
    matcher.resize(100, 30);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(true);
    matcher.resize(1000, 30);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(false);
  });
  it('resize and redraw do not recover unknown persistent modes', () => {
    const matcher = ready();
    matcher.ingest('\x1b[?6h');
    matcher.resize(100, 30);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(false);
  });
  it.each(['50', '1337', '666'])('unknown OSC %s poisons until fresh session', command => {
    const matcher = ready();
    matcher.ingest('\x1b]' + command + ';payload\x07' + redraw);
    expect(matcher.state().active).toBe(false);
  });
  it('suppresses evidence until synchronized output ends, including across resize', () => {
    const matcher = ready();
    matcher.ingest('\x1b[?2026h' + redraw);
    expect(matcher.state().active).toBe(false);
    matcher.resize(100, 30);
    matcher.ingest(redraw);
    expect(matcher.state().active).toBe(false);
    matcher.ingest('\x1b[?2026l');
    expect(matcher.state().active).toBe(true);
  });
  it('accepts the last column but fails closed before unsupported autowrap', () => {
    const matcher = ready();
    matcher.ingest('\x1b[1;100Hx');
    expect(matcher.state().active).toBe(true);
    matcher.ingest('y');
    expect(matcher.state().active).toBe(false);
    matcher.ingest(redraw);
    matcher.ingest('\x1b[1;100Hx\bZ\x1b[H');
    expect(matcher.state().active).toBe(true);
  });
  it('reset discards history and partial parser state; exposes no payload', () => {
    const matcher = ready();
    matcher.ingest('\x1b]8;;unfinished');
    matcher.reset();
    expect(matcher.state()).toEqual({ seenAt: null, active: false });
    matcher.ingest('Yes, I trust this folder');
    expect(matcher.state().active).toBe(false);
    matcher.ingest(captured);
    expect(matcher.state()).toEqual({ seenAt: 42, active: true });
    expect(Object.keys(matcher.state())).toEqual(['seenAt', 'active']);
  });
});

