import { promises as fsp } from 'fs';
import path from 'path';

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
    const stat = await fsp.stat(filePath);
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file: filePath, mtimeMs: stat.mtimeMs };
  }
  return best;
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
