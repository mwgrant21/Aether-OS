/**
 * Turns a transcript event's `cwd` into a project identity.
 *
 * Pure and filesystem-injected. The probe is a parameter rather than a direct
 * fs call so every case below is testable without touching disk, and so this
 * module carries no `node:` import that could reach the renderer bundle.
 */

export interface ProjectRef {
  /** Normalized absolute path of the repo root. Never leaves the main process. */
  repoPath: string;
  /** Basename of repoPath -- the only part safe to display or transmit. */
  repoName: string;
  /** Worktree name, or null for the repo's own checkout. */
  worktree: string | null;
}

/** True when `<dir>/.git` exists as either a directory or a file. */
export type GitProbe = (dir: string) => boolean;

/**
 * Forward-slash the separators and drop a trailing separator. For
 * Windows-style paths (leading drive letter), lowercase the entire path --
 * Windows filesystems are case-insensitive, so `C:\...\Aether-OS` and
 * `c:/.../aether-os/` must resolve to one project. POSIX-style paths (no
 * drive letter) are left case-sensitive, matching typical POSIX filesystems.
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
}

// Matches `/.claude/worktrees/<name>` or `/.worktrees/<name>`, capturing the
// prefix (the parent repo) and the worktree name.
const WORKTREE_RE = /^(.*?)\/(?:\.claude\/worktrees|\.worktrees)\/([^/]+)(?:\/.*)?$/;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function parentOf(path: string): string | null {
  const i = path.lastIndexOf('/');
  if (i <= 0) return null;
  const parent = path.slice(0, i);
  // `c:` is the drive root -- stop rather than looping on it.
  return /^[a-z]:$/.test(parent) ? null : parent;
}

export function resolveProject(cwd: string | null, probe: GitProbe): ProjectRef | null {
  if (!cwd) return null;
  const path = normalizePath(cwd);
  if (!path) return null;

  // Rule 1 -- worktree by path shape. Deliberately BEFORE any probe: a worktree
  // deleted from disk must stay attributable to its parent repo.
  const wt = WORKTREE_RE.exec(path);
  if (wt) {
    const repoPath = wt[1];
    return { repoPath, repoName: basename(repoPath), worktree: wt[2] };
  }

  // Rule 2 -- nearest ancestor with a .git entry. Nearest, so a stray repo
  // above a real one never captures it.
  for (let dir: string | null = path; dir !== null; dir = parentOf(dir)) {
    if (probe(dir)) return { repoPath: dir, repoName: basename(dir), worktree: null };
  }

  // Rule 3 -- unattributable.
  return null;
}
