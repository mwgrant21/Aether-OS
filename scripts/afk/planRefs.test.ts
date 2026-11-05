// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRefsIn, specIsApproved, specPathOfPlan } from './planRefs.mjs';
describe('specIsApproved', () => {
  it.each([
    ['plain', '# T\n\nStatus: APPROVED by Matt 2026-11-04 as written.\n', true],
    ['bold with comma', '# T\n**Status:** Approved, pending implementation plan\n', true],
    ['lowercase with date', 'Status: approved 2026-10-11. Amended\n', true],
    ['bullet', '- **Status:** design approved in conversation, awaiting written-spec review\n', false],
    ['draft', 'Status: DRAFT\n', false],
    ['superseded', 'Status: approved, superseded by x\n', false],
    ['no status line', '# T\nsome text\n', false],
    ['status after line 15', '\n'.repeat(16) + 'Status: approved\n', false],
  ])('%s', (_n, md, want) => { expect(specIsApproved(md)).toBe(want); });
});
describe('specPathOfPlan', () => {
  it('takes the first backticked path on the **Spec:** line', () => {
    expect(specPathOfPlan('x\n**Spec:** `docs/superpowers/specs/a-design.md` (note `b`)\n')).toBe('docs/superpowers/specs/a-design.md');
  });
  it('null when absent', () => { expect(specPathOfPlan('no spec line')).toBeNull(); });
});
describe('planRefsIn', () => {
  it('finds plan files by either prefix, de-duplicated', () => {
    expect(planRefsIn('see docs/superpowers/plans/2026-10-12-dashboards.md T3 and plans/other.md and plans/other.md'))
      .toEqual(['2026-10-12-dashboards.md', 'other.md']);
  });
  it('none', () => { expect(planRefsIn('nothing')).toEqual([]); });
});
