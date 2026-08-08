import { promises as fsp } from 'fs';
import path from 'path';
import { parseTranscriptLine, type TranscriptEvent } from './transcriptParser';

// Reads one .jsonl file and appends every parseable line's event to `events`.
// Shared by the top-level session scan and the subagent-file scan below so
// both paths parse identically.
async function scanJsonlFile(filePath: string, events: TranscriptEvent[]): Promise<void> {
  const content = await fsp.readFile(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const event = parseTranscriptLine(line);
    if (event) events.push(event);
  }
}

export async function scanAllProjects(projectsRoot: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch (err: any) {
    if (err.code === 'ENOENT') return events;
    throw err;
  }

  for (const dirEntry of projectDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dirPath = path.join(projectsRoot, dirEntry.name);
    const files = await fsp.readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      await scanJsonlFile(path.join(dirPath, file), events);

      // Per electron/transcriptReader.ts's documented on-disk layout, a
      // top-level session file <sessionId>.jsonl has its dispatched
      // subagents' OWN token usage in separate, nested files:
      //   <dirPath>/<sessionId>/subagents/agent-<agentId>.jsonl
      // These are never read by the flat readdir above, so every ledger
      // total/rollup built from scanAllProjects previously undercounted
      // exactly the dispatch workloads Cost Forensics exists to analyze.
      const sessionId = file.slice(0, -'.jsonl'.length);
      const subagentsDir = path.join(dirPath, sessionId, 'subagents');
      let subagentFiles: string[];
      try {
        subagentFiles = await fsp.readdir(subagentsDir);
      } catch {
        continue; // no subagents dir for this session -- not an error
      }
      for (const subFile of subagentFiles) {
        if (!subFile.endsWith('.jsonl')) continue;
        await scanJsonlFile(path.join(subagentsDir, subFile), events);
      }
    }
  }
  return events;
}
