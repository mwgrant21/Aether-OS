import { describe, expect, it } from 'vitest';
import { parseActionLine } from './actionParser';

describe('parseActionLine', () => {
  it('strips a well-formed action line for a recognized verb and returns the parsed action', () => {
    const reply = 'I\'ll get a fresh set of hands on this.\n{"verb":"spawn","args":{"name":"Nightwatch"}}';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe("I'll get a fresh set of hands on this.");
    expect(action).toEqual({ verb: 'spawn', args: { name: 'Nightwatch' } });
  });

  it('handles theme/renderer/kill/throttle verbs identically', () => {
    expect(parseActionLine('Done.\n{"verb":"theme","args":{"name":"violet"}}').action?.verb).toBe('theme');
    expect(parseActionLine('Done.\n{"verb":"renderer","args":{"mode":"warp"}}').action?.verb).toBe('renderer');
    expect(parseActionLine('Done.\n{"verb":"kill","args":{"name":"Code Builder"}}').action?.verb).toBe('kill');
    expect(parseActionLine('Done.\n{"verb":"throttle","args":{"name":"Code Builder"}}').action?.verb).toBe('throttle');
  });

  it('returns the whole reply unchanged with no action for plain prose (no JSON line)', () => {
    const { text, action } = parseActionLine('Just a normal reply.');
    expect(text).toBe('Just a normal reply.');
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged with no action when the last line is malformed JSON', () => {
    const reply = 'Reply text.\n{not valid json';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe(reply);
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged with no action for an unrecognized verb (e.g. a stray "status")', () => {
    const reply = 'Reply text.\n{"verb":"status","args":{}}';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe(reply);
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged when args is missing or not an object', () => {
    expect(parseActionLine('Reply.\n{"verb":"spawn"}').action).toBeNull();
    expect(parseActionLine('Reply.\n{"verb":"spawn","args":"nope"}').action).toBeNull();
  });

  it('handles trailing blank lines gracefully', () => {
    const reply = 'Reply text.\n{"verb":"theme","args":{"name":"amber"}}\n\n';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe('Reply text.');
    expect(action?.verb).toBe('theme');
  });

  it('never throws on empty or whitespace-only input', () => {
    expect(() => parseActionLine('')).not.toThrow();
    expect(parseActionLine('   ').action).toBeNull();
  });
});
