import { promises as fsp } from 'fs';
import path from 'path';

/**
 * mtime of a single file, or null if it cannot be stat'd.
 *
 * A path listed by readdir can still fail to stat: it may be deleted in the
 * window between the two calls (transcripts are rotated while being read), be
 * a dangling symlink, or be individually unreadable. Callers on a periodic
 * critical path must be able to skip one bad entry rather than have the whole
 * sweep reject -- see findNewestTranscriptMtimeMs, which runs every scan cycle
 * ahead of the usage, Ledger and Projects snapshots.
 */
export async function safeStatMtimeMs(filePath: string): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function findActiveSessionFileInDir(dirPath: string): Promise<{ file: string; mtimeMs: number } | null> {
  let files: string[];
  try {
    files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const mtimeMs = await safeStatMtimeMs(filePath);
    if (mtimeMs === null) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { file: filePath, mtimeMs };
  }
  return best;
}

/**
 * Newest mtime among a session's nested subagent transcripts, or null.
 *
 * Deliberately NOT folded into findActiveSessionFileInDir: that helper backs
 * session PINNING (findMostRecentSessionFile / findSessionFileCreatedAfter),
 * where a subagent's file is not a session file and must never be returned as
 * one. Only the freshness sweep needs to see these.
 */
async function newestSubagentMtimeMs(dirPath: string, sessionFile: string): Promise<number | null> {
  const sessionId = sessionFile.slice(0, -'.jsonl'.length);
  const subagentsDir = path.join(dirPath, sessionId, 'subagents');
  let subFiles: string[];
  try {
    subFiles = (await fsp.readdir(subagentsDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null; // no subagents dir is the common case
  }
  let newest: number | null = null;
  for (const f of subFiles) {
    const mtimeMs = await safeStatMtimeMs(path.join(subagentsDir, f));
    if (mtimeMs === null) continue;
    if (newest === null || mtimeMs > newest) newest = mtimeMs;
  }
  return newest;
}

/**
 * Newest transcript mtime across every project, or null when there are no
 * transcripts at all. Used to tell a collector that has STOPPED writing from
 * one that is merely idle because nothing is being written -- see
 * collectorFreshness.ts.
 *
 * Covers nested <sessionId>/subagents/*.jsonl as well as flat session files,
 * matching what scanAllProjects actually reads. A long-running subagent can
 * keep writing real usage while the parent transcript's mtime never moves; a
 * flat-only sweep would see no activity, leave a dead collector looking caught
 * up, and hold the dashboard undercounted until the parent file happened to
 * change. This one never rejects -- an unreadable entry is skipped, because
 * the whole sweep sits ahead of the usage, Ledger and Projects snapshots on
 * every cycle.
 */
export async function findNewestTranscriptMtimeMs(projectsRoot: string): Promise<number | null> {
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  const consider = (v: number | null) => {
    if (v !== null && (newest === null || v > newest)) newest = v;
  };

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, dirEntry.name);

    let files: string[];
    try {
      files = (await fsp.readdir(dirPath)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      consider(await safeStatMtimeMs(path.join(dirPath, file)));
      consider(await newestSubagentMtimeMs(dirPath, file));
    }
  }
  return newest;
}

export async function findMostRecentSessionFile(projectsRoot: string): Promise<string | null> {
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const candidate = await findActiveSessionFileInDir(path.join(projectsRoot, dirEntry.name));
    if (candidate && (!best || candidate.mtimeMs > best.mtimeMs)) best = candidate;
  }
  return best ? best.file : null;
}

// Scoped to one project directory (rather than every project on the machine)
// and gated on `sinceMs` so a stale file left over from a previous run can
// never match -- only the freshly created session file from a just-spawned
// `claude` process will have a newer mtime than its own spawn time.
export async function findSessionFileCreatedAfter(dirPath: string, sinceMs: number): Promise<string | null> {
  const candidate = await findActiveSessionFileInDir(dirPath);
  if (candidate && candidate.mtimeMs >= sinceMs) return candidate.file;
  return null;
}
