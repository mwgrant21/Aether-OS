// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyItem } from './classify.mjs';
describe('classifyItem', () => {
  it.each([
    ['Delete .worktrees/collector-build: DECIDED option A (Matt, 2026-11-04) - leave it until the collector next restarts', 'barred'],
    ['Force-push the rebased branch', 'barred'],
    ['git branch -D feat/x after the merge', 'barred'],
    ['Ask Matt (one message) whether to push docs/afk-mode-design and open a docs-only PR; do not push without his go', 'question'],
    ['Tell Matt the outcome of step 1. If mostly `[]`, options B and C go to Matt, not decided here.', 'question'],
    ['Optional follow-up ticket: s14 sentence + parser nits. Do not push commits onto merged work.', 'question'],
    ['Which approach should the runner take?', 'question'],
    ['collector rebuild from merged master needs a fresh go', 'question'],
    ['Before planning Phase 2, verify the prototype: run git branch -a and check which branches are merged', 'ready'],
    ['Run npm test and fix the two failing starters tests in src/shared/dashboards', 'ready'],
    ['Build the APK for aethermobile with the titan IP', 'ready'],
    ['Remove the stale worktree directories', 'barred'],
    ['Purge old logs from the spool', 'barred'],
    ['git clean -fdx the checkout', 'barred'],
    ['git rm the generated file', 'barred'],
  ])('%s -> %s', (text, verdict) => {
    expect(classifyItem(text).verdict).toBe(verdict);
  });
  it('barred beats question and reports why', () => {
    const r = classifyItem('Delete the worktree; ask Matt first?');
    expect(r.verdict).toBe('barred');
    expect(r.reasons[0]).toBe('barred:delete');
  });
  it('ready carries no reasons', () => {
    expect(classifyItem('Run npm test').reasons).toEqual([]);
  });
});
