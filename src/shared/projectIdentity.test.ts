import { describe, it, expect } from 'vitest';
import { normalizePath, resolveProject, type GitProbe } from './projectIdentity';

// A probe that answers true only for the exact directories listed.
const probeFor = (repos: string[]): GitProbe => {
  const set = new Set(repos.map(normalizePath));
  return (dir) => set.has(normalizePath(dir));
};

const NO_REPOS: GitProbe = () => false;

describe('normalizePath', () => {
  it('lowercases the drive letter, forward-slashes, and strips a trailing separator', () => {
    expect(normalizePath('C:\\Users\\IT\\Desktop\\Aether-OS\\')).toBe('c:/Users/IT/Desktop/Aether-OS');
    expect(normalizePath('c:/Users/IT/Desktop/Aether-OS')).toBe('c:/Users/IT/Desktop/Aether-OS');
  });
});

describe('resolveProject', () => {
  const AETHER = 'C:\\Users\\IT\\Desktop\\Aether-OS';

  it('resolves a repo root to itself with no worktree', () => {
    expect(resolveProject(AETHER, probeFor([AETHER]))).toEqual({
      repoPath: normalizePath(AETHER),
      repoName: 'Aether-OS',
      worktree: null,
    });
  });

  it('rolls a subdirectory up to its repo root', () => {
    const sub = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2\\src\\renderer';
    const repo = 'C:\\Users\\IT\\Desktop\\TokenMonitorV2';
    expect(resolveProject(sub, probeFor([repo]))?.repoName).toBe('TokenMonitorV2');
  });

  // Rule 1 must not consult the filesystem: this worktree no longer exists.
  it('identifies a .claude/worktrees path with no filesystem support at all', () => {
    const wt = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.claude\\worktrees\\statusline-feed';
    expect(resolveProject(wt, NO_REPOS)).toEqual({
      repoPath: normalizePath(AETHER),
      repoName: 'Aether-OS',
      worktree: 'statusline-feed',
    });
  });

  it('identifies a .worktrees path the same way', () => {
    const wt = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.worktrees\\feature-x';
    expect(resolveProject(wt, NO_REPOS)?.worktree).toBe('feature-x');
  });

  it('rolls a subdirectory inside a worktree up to that worktree', () => {
    const deep = 'C:\\Users\\IT\\Desktop\\Aether-OS\\.claude\\worktrees\\wt1\\src\\state';
    const r = resolveProject(deep, NO_REPOS);
    expect(r?.worktree).toBe('wt1');
    expect(r?.repoName).toBe('Aether-OS');
  });

  // The stray C:\Users\IT\Desktop\.git on this machine must not capture repos
  // nested under it -- nearest wins.
  it('prefers the innermost repo when a stray repo exists above it', () => {
    const repo = 'C:\\Users\\IT\\Desktop\\Aether-OS';
    const stray = 'C:\\Users\\IT\\Desktop';
    expect(resolveProject(repo, probeFor([repo, stray]))?.repoName).toBe('Aether-OS');
  });

  it('falls back to the stray repo only for a path that is not itself a repo', () => {
    const loose = 'C:\\Users\\IT\\Desktop\\loose-folder';
    expect(resolveProject(loose, probeFor(['C:\\Users\\IT\\Desktop']))?.repoName).toBe('Desktop');
  });

  it('returns null for a path with no repo ancestor', () => {
    expect(resolveProject('C:\\Users\\IT', NO_REPOS)).toBeNull();
  });

  it('returns null for a null or empty cwd', () => {
    expect(resolveProject(null, NO_REPOS)).toBeNull();
    expect(resolveProject('', NO_REPOS)).toBeNull();
  });

  it('treats differently-cased and differently-separated paths as one project', () => {
    const a = resolveProject('C:\\Users\\IT\\Desktop\\Aether-OS', probeFor(['C:\\Users\\IT\\Desktop\\Aether-OS']));
    const b = resolveProject('c:/Users/IT/Desktop/Aether-OS/', probeFor(['C:\\Users\\IT\\Desktop\\Aether-OS']));
    expect(a?.repoPath).toBe(b?.repoPath);
  });

  it('probes each ancestor at most once and terminates at the drive root', () => {
    const seen: string[] = [];
    const counting: GitProbe = (dir) => { seen.push(dir); return false; };
    resolveProject('C:\\a\\b\\c', counting);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});
