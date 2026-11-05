// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS } from './terms.mjs';
import { buildAllowRules, buildDenyRules } from './denyRules.mjs';
describe('buildDenyRules', () => {
  const base = buildDenyRules(DEFAULT_TERMS);
  // Both groups in full, so a dropped or renamed rule (rmdir, del, rd, erase, ri, git rm, branch -d/--delete, worktree prune) fails here.
  const PROTECT = ['Edit(~/.aether-os/afk/**)', 'Write(~/.aether-os/afk/**)', 'Edit(~/.claude/away*)', 'Write(~/.claude/away*)'];
  const ALWAYS = [
    'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(del:*)', 'Bash(rd:*)', 'Bash(erase:*)', 'Bash(Remove-Item:*)', 'Bash(ri:*)',
    'Bash(git clean:*)', 'Bash(git rm:*)', 'Bash(git branch -D:*)', 'Bash(git branch -d:*)', 'Bash(git branch --delete:*)',
    'Bash(git worktree remove:*)', 'Bash(git worktree prune:*)',
    'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --delete:*)',
    'Bash(git push origin HEAD:master:*)', 'Bash(git push origin HEAD:main:*)',
  ];
  it('under the defaults protect is exactly the four path rules and run is exactly the stated list: delete verbs, force-push variants, HEAD:master/main', () => {
    expect([...base.protect].sort()).toEqual([...PROTECT].sort());
    expect([...base.run].sort()).toEqual([...ALWAYS].sort());
  });
  it('the split is clean: no path rule in run, no Bash rule in protect, no rule in both, and protect does not depend on terms', () => {
    expect(base.run.some((r) => /^(Edit|Write)\(/.test(r))).toBe(false);
    expect(base.protect.some((r) => r.startsWith('Bash('))).toBe(false);
    expect(base.run.filter((r) => base.protect.includes(r))).toEqual([]);
    expect(buildDenyRules({ ...DEFAULT_TERMS, push: false, merge: 'off' }).protect).toEqual(base.protect);
  });
  it('does NOT carry the prototype blanket push/merge/gh denial under the defaults', () => {
    for (const r of ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh:*)', 'Bash(gh pr merge:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'])
      expect(base.run).not.toContain(r);
  });
  it('push:false and merge:off add exactly the matching rules, to run only', () => {
    const r = buildDenyRules({ ...DEFAULT_TERMS, push: false, merge: 'off' });
    expect([...r.run].sort()).toEqual([...ALWAYS, 'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh pr merge:*)'].sort());
    expect([...r.protect].sort()).toEqual([...PROTECT].sort());
  });
  it('delete and force-push rules are emitted whatever the terms say', () => {
    const r = buildDenyRules({ ...DEFAULT_TERMS, delete: true, forcePush: true });
    for (const x of ['Bash(rm:*)', 'Bash(git push --force:*)', 'Bash(git branch -D:*)']) expect(r.run).toContain(x);
  });
});
describe('buildAllowRules', () => {
  const apk = { project: 'aether-os', kind: 'build', artifact: 'apk' };
  const exe = { project: 'aether-os', kind: 'build', artifact: 'installer' };
  const work = { project: 'aether-os', kind: 'work', artifact: null };
  it('defaults: read-only git/gh, push and ff-only merge, and no Edit/Write rule for a work item', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [work]);
    expect(r).toEqual(expect.arrayContaining(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(gh pr view:*)', 'Bash(git push:*)', 'Bash(git merge --ff-only:*)']));
    expect(r.some((x) => /^(Edit|Write)/.test(x))).toBe(false);
    expect(r).not.toContain('Bash(gh pr merge:*)');
  });
  it('build items add their recipe command prefix, without flags, and nothing else', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [apk, exe]);
    expect(r).toEqual(expect.arrayContaining(['Bash(gradlew.bat assembleDebug:*)', 'Bash(npm run dist:*)']));
    expect(buildAllowRules(DEFAULT_TERMS, [apk]).join(' ')).not.toContain('npm run dist');
    expect(r.join(' ')).not.toContain('AETHER_TITAN');
  });
  it('a build item with no recipe adds nothing', () => {
    expect(buildAllowRules(DEFAULT_TERMS, [{ project: 'MobileCrawler', kind: 'build', artifact: 'apk' }])).toEqual(buildAllowRules(DEFAULT_TERMS, []));
  });
  it('push:false and merge:off remove the push and merge rules', () => {
    const r = buildAllowRules({ ...DEFAULT_TERMS, push: false, merge: 'off' }, []);
    expect(r).not.toContain('Bash(git push:*)'); expect(r).not.toContain('Bash(git merge --ff-only:*)');
  });
  it('is sorted, de-duplicated, never broad, never overlaps the deny list, never mentions bypass', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [apk, apk, exe]);
    expect(r).toEqual([...new Set(r)].sort());
    expect(r).not.toContain('Bash'); expect(r).not.toContain('Bash(*)');
    const d = buildDenyRules(DEFAULT_TERMS);
    for (const x of r) { expect(d.run).not.toContain(x); expect(d.protect).not.toContain(x); }
    expect(JSON.stringify(r).toLowerCase()).not.toContain('bypass');
  });
});
