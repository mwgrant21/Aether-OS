// Deny-rule and allow-rule builders (Claude Code permission-rule syntax).
// A string in a list is not enforcement: how a headless run treats these is UNVERIFIED until T21 M2/M5.
//
// buildDenyRules(terms) -> {protect, run}
//   protect: the four path rules Matt pastes into global settings. Same for any terms.
//   run:     delete verbs, force-push, exact-form pushes to master/main, and the conditional
//            push/merge rules. Phase 2's per-run disallow list. NEVER paste globally: it would
//            block rm, git branch -d, git worktree remove and git rm in every interactive session.
//
// Limits: prefix rules cannot catch `git push origin +main` or `git push origin :branch`, and miss
// `git push origin main --force` / `-f` (the flag follows the remote). The allowlist's
// `Bash(git push:*)` also permits a push to master that skips merge-gate: the two exact-form run
// rules stop `HEAD:master` and `HEAD:main` as typed, but `HEAD:refs/heads/master`, `origin main`,
// `upstream HEAD:master` and other spellings still pass. The Safety Net hook is the second layer
// (unexercised until T21 M2). Redirection into the terms file is not expressible as a rule.
// Every rule is Bash(...); whether it covers the PowerShell tool is UNVERIFIED (T21 M2).
import { getRecipe } from './recipes.mjs';

const PROTECT = [
  'Edit(~/.aether-os/afk/**)',
  'Write(~/.aether-os/afk/**)',
  'Edit(~/.claude/away*)',
  'Write(~/.claude/away*)',
];

const RUN_ALWAYS = [
  'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(del:*)', 'Bash(rd:*)', 'Bash(erase:*)', 'Bash(Remove-Item:*)', 'Bash(ri:*)',
  'Bash(git clean:*)', 'Bash(git rm:*)', 'Bash(git branch -D:*)', 'Bash(git branch -d:*)', 'Bash(git branch --delete:*)',
  'Bash(git worktree remove:*)', 'Bash(git worktree prune:*)',
  'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --delete:*)',
  'Bash(git push origin HEAD:master:*)', 'Bash(git push origin HEAD:main:*)',
];

const ALLOW_ALWAYS = [
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git rev-parse:*)',
  'Bash(git merge-base:*)', 'Bash(git fetch:*)',
  'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr diff:*)',
  'Bash(gh run list:*)', 'Bash(gh run view:*)',
];

const uniq = (list) => [...new Set(list)];

export function buildDenyRules(terms) {
  const run = [...RUN_ALWAYS];
  if (terms.push === false) run.push('Bash(git push:*)');
  if (terms.merge === 'off') run.push('Bash(git merge:*)', 'Bash(gh pr merge:*)');
  return { protect: uniq(PROTECT), run: uniq(run) };
}

export function buildAllowRules(terms, items) {
  const rules = [...ALLOW_ALWAYS];
  if (terms.push === true) rules.push('Bash(git push:*)');
  if (terms.merge === 'gated') rules.push('Bash(git merge --ff-only:*)');
  for (const item of items || []) {
    if (!item || item.kind !== 'build') continue;
    const recipe = getRecipe(item.project, item.artifact);
    if (!recipe || !Array.isArray(recipe.argv)) continue;
    const prefix = [];
    for (const tok of recipe.argv) {
      if (tok.startsWith('-')) break;
      prefix.push(tok);
    }
    if (prefix.length > 0) rules.push(`Bash(${prefix.join(' ')}:*)`);
  }
  return uniq(rules).sort();
}
