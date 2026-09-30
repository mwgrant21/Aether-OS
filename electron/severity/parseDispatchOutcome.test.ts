import { describe, it, expect } from 'vitest';
import { parseDispatchOutcome, unrecognisedStatusTag } from './parseDispatchOutcome';

// Synthetic notifications shaped like Claude Code's task-notification.
// No real transcript content.
function note(status: string | null, usage?: { tokens: number; toolUses: number; durationMs: number }, extra = ''): string {
  return (
    '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id>' +
    (status === null ? '' : `<status>${status}</status>`) +
    '<summary>Agent "x" finished</summary>' +
    extra +
    (usage
      ? `<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
      : '') +
    '</task-notification>'
  );
}

describe('parseDispatchOutcome', () => {
  it('completed with usage', () => {
    expect(parseDispatchOutcome(note('completed', { tokens: 1200, toolUses: 7, durationMs: 65000 }))).toEqual({
      status: 'completed',
      usage: { tokens: 1200, toolUses: 7, durationMs: 65000 },
    });
  });

  it('failed without usage gives usage undefined, never zeros', () => {
    const r = parseDispatchOutcome(note('failed'));
    expect(r.status).toBe('failed');
    expect(r.usage).toBeUndefined();
  });

  it('killed without usage', () => {
    const r = parseDispatchOutcome(note('killed'));
    expect(r).toEqual({ status: 'killed' });
  });

  it('missing status tag is unknown', () => {
    expect(parseDispatchOutcome(note(null)).status).toBe('unknown');
  });

  it('unrecognised status tag is unknown', () => {
    expect(parseDispatchOutcome(note('running')).status).toBe('unknown');
  });

  it('a partial usage block (one tag missing) is no usage, not zeros', () => {
    const text = '<status>completed</status><subagent_tokens>5</subagent_tokens><tool_uses>1</tool_uses>';
    expect(parseDispatchOutcome(text)).toEqual({ status: 'completed' });
  });

  it('never throws on non-string input', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('x')]) {
      expect(() => parseDispatchOutcome(bad)).not.toThrow();
      expect(parseDispatchOutcome(bad)).toEqual({ status: 'unknown' });
    }
  });

  // Review Focus 1
  it('ignores tags quoted inside summary/result', () => {
    const quoted =
      '<result>The format is <status>failed</status> with <subagent_tokens>1</subagent_tokens><tool_uses>1</tool_uses><duration_ms>1</duration_ms></result>';
    const r = parseDispatchOutcome(note('completed', { tokens: 900, toolUses: 3, durationMs: 4000 }, quoted));
    expect(r).toEqual({ status: 'completed', usage: { tokens: 900, toolUses: 3, durationMs: 4000 } });

    const summaryQuote =
      '<task-notification><tool-use-id>tu_2</tool-use-id><summary>saw <status>failed</status></summary></task-notification>';
    expect(parseDispatchOutcome(summaryQuote).status).toBe('unknown');
  });

  it('result carries no string field other than status', () => {
    const inputs = [
      note('completed', { tokens: 1, toolUses: 1, durationMs: 1 }, '<result>secret source code</result>'),
      note('failed', undefined, '<result>stack trace here</result>'),
      note('weird'),
    ];
    for (const text of inputs) {
      const r = parseDispatchOutcome(text) as unknown as Record<string, unknown>;
      expect(Object.keys(r).every((k) => k === 'status' || k === 'usage')).toBe(true);
      if (r.usage !== undefined) {
        expect(Object.values(r.usage as object).every((v) => typeof v === 'number')).toBe(true);
      }
      expect(JSON.stringify(r)).not.toMatch(/secret|stack trace/);
    }
  });
});

describe('unrecognisedStatusTag', () => {
  it('is null for recognised statuses', () => {
    expect(unrecognisedStatusTag(note('completed'))).toBeNull();
    expect(unrecognisedStatusTag(note('failed'))).toBeNull();
    expect(unrecognisedStatusTag(note('killed'))).toBeNull();
  });
  it('names a plain unknown value, and hides anything else', () => {
    expect(unrecognisedStatusTag(note('running'))).toBe('running');
    expect(unrecognisedStatusTag(note(null))).toBe('<missing>');
    expect(unrecognisedStatusTag(note('C:\\Users\\bob secret'))).toBe('<unprintable>');
    expect(unrecognisedStatusTag(undefined)).toBe('<missing>');
  });
});
