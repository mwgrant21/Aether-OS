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
  it.each([
    'git push -f origin x', 'git push origin HEAD:master -f', 'git push origin +master',
  ])('force-push variant is barred: %s', (text) => {
    const r = classifyItem(text);
    expect(r.verdict).toBe('barred');
    expect(r.reasons).toContain('barred:force-push');
  });
  it.each([
    'git push origin :old-branch', 'rm -fr build', 'git -C x clean -fd', 'Deleted the stale branch',
    'deletes old logs', 'del /s /q build', 'rd /s /q build', 'git stash drop',
  ])('delete variant is barred: %s', (text) => {
    expect(classifyItem(text).verdict).toBe('barred');
  });
  it.each(['Clean up the worktree', 'clean up worktrees'])('cleanup variant is barred: %s', (text) => {
    expect(classifyItem(text).reasons).toContain('barred:cleanup');
  });
  it.each([
    'Deletion of old files', 'removal of old logs', 'Pruning stale branches', 'rm x.txt', 'rm -f x.txt',
    'rm --recursive x', 'rm -f -r x', 'del x.txt', 'del /f /q x', 'erase x.txt', 'unlink x', 'rd build',
    'rd/s/q x', 'rimraf dist', 'git reset origin/master --hard', 'git reset HEAD --hard',
    'git branch -vd x', 'git branch -rd x', 'git branch -fD x', 'git tag -d v1', 'git tag --delete v1',
    'git update-ref -d refs/heads/x', 'git remote rm origin', 'docker rm -f web', 'docker rmi img',
    'wipe the disk', 'nuke the cache', 'destroy the VM', 'trash the old build', 'shred secrets.txt',
    'truncate -s 0 log', 'Format-Volume -DriveLetter E', 'Clear-Content log.txt',
    'git checkout -f', 'git checkout -- .', 'git restore .', 'git filter-branch --all', 'git reflog expire --all',
    'git push\norigin\n:old', 'rm\u00a0x', 'rm\tx',
    '\uFF52\uFF4D -rf x', 'dele\u200bte the logs', 'dele\u0301te the logs',
    'git push -d origin x', 'Hard reset the branch', 'Hard-reset the repo', 'hard reset to origin',
    'reset hard', 'git reset -- hard',
  ])('delete variant is barred (broad stems): %s', (text) => {
    expect(classifyItem(text).verdict).toBe('barred');
  });
  it.each([
    'git push origin master -fu', 'Force  push', 'force_push', 'forcepush', 'Forcibly push', 'push with force',
    'force\u00a0push', 'force\tpush', 'force\npush', 'git push --mirror', 'git push -f -u origin x',
    'git push origin x\n\n -f',
  ])('force-push variant is barred (broad): %s', (text) => {
    const r = classifyItem(text);
    expect(r.verdict).toBe('barred');
    expect(r.reasons).toContain('barred:force-push');
  });
  it.each([
    'cleaning up', 'cleaned up', 'clean   up', 'Clean the worktree', 'clean old worktrees', 'npm run clean',
    'make clean', 'gradlew clean', 'tidy up',
  ])('cleanup variant is barred (stem): %s', (text) => {
    expect(classifyItem(text).reasons).toContain('barred:cleanup');
  });
  it('long input classifies fast', () => {
    const t0 = Date.now();
    const r = classifyItem('push '.repeat(10000));
    expect(r.verdict).toBe('ready');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('full-width question mark is a question', () => {
    expect(classifyItem('Which one\uFF1F').verdict).toBe('question');
  });
  it('ready carries no reasons', () => {
    expect(classifyItem('Run npm test').reasons).toEqual([]);
  });
});
