// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseLedgerTodos, parseNextSteps } from './parseSources.mjs';
describe('parseNextSteps', () => {
  it('collects numbered items, joins continuation lines, stops at the next ## heading', () => {
    const md = '# H\n\n## Next steps\n1. First thing\n   continues here\n2. Second thing\n\n## Decisions\n- not me\n';
    expect(parseNextSteps(md)).toEqual({
      found: true, headingNote: null,
      items: [{ n: 1, text: 'First thing continues here' }, { n: 2, text: 'Second thing' }],
    });
  });
  it('a ## Update heading ends the section but ### does not', () => {
    const md = '## Next steps\n1. A\n### Sub\n2. B\n## Update 12:50 - x\n3. C\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['A', 'B']);
  });
  it('keeps the heading note', () => {
    expect(parseNextSteps('## Next steps (all need Matt)\n1. Do it\n').headingNote).toBe('all need Matt');
  });
  it('ignores numbered lines in code fences', () => {
    const md = '## Next steps\n1. Real\n```\n2. fake\n```\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['Real']);
  });
  it('reports not found', () => {
    expect(parseNextSteps('# nothing here\n')).toEqual({ found: false, headingNote: null, items: [] });
  });
});
describe('parseLedgerTodos', () => {
  it('returns todo and pending, nothing else', () => {
    const md = '- [todo] read-only tally\n- [done] x\n- [pending Matt] collector restart\n- [running] y\n- [MERGED 22c5f68] z\n';
    expect(parseLedgerTodos(md)).toEqual([
      { state: 'todo', note: null, text: 'read-only tally' },
      { state: 'pending', note: 'Matt', text: 'collector restart' },
    ]);
  });
});
