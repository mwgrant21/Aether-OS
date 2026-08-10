import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { findNewestTranscriptMtimeMs, safeStatMtimeMs } from './activeSessionFinder';

let root: string;

async function writeTranscript(project: string, file: string, mtime: Date) {
  const dir = path.join(root, project);
  await fsp.mkdir(dir, { recursive: true });
  const full = path.join(dir, file);
  await fsp.writeFile(full, '{}\n');
  await fsp.utimes(full, mtime, mtime);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aether-newest-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('findNewestTranscriptMtimeMs', () => {
  it('returns null when the projects root does not exist', async () => {
    expect(await findNewestTranscriptMtimeMs(path.join(root, 'nope'))).toBeNull();
  });

  it('returns null when no project holds a transcript', async () => {
    await fsp.mkdir(path.join(root, 'empty-project'), { recursive: true });
    expect(await findNewestTranscriptMtimeMs(root)).toBeNull();
  });

  it('returns the newest mtime across every project directory', async () => {
    const older = new Date('2026-08-01T00:00:00Z');
    const newest = new Date('2026-08-09T12:30:00Z');
    await writeTranscript('project-a', 'aaa.jsonl', older);
    await writeTranscript('project-b', 'bbb.jsonl', newest);
    await writeTranscript('project-c', 'ccc.jsonl', older);

    expect(await findNewestTranscriptMtimeMs(root)).toBe(newest.getTime());
  });

  it('counts a nested subagent transcript as activity', async () => {
    // scanAllProjects reads <sessionId>/subagents/agent-*.jsonl as well as the
    // flat session file. A long-running subagent can therefore keep writing
    // real usage while the top-level transcript's mtime never moves -- if this
    // walk misses those files, a collector that has stopped still looks caught
    // up and the dashboard stays undercounted.
    const older = new Date('2026-08-01T00:00:00Z');
    const newest = new Date('2026-08-09T18:00:00Z');
    await writeTranscript('project-a', 'session-1.jsonl', older);
    await writeTranscript(path.join('project-a', 'session-1', 'subagents'), 'agent-7.jsonl', newest);

    expect(await findNewestTranscriptMtimeMs(root)).toBe(newest.getTime());
  });

  it('skips a file that vanishes between readdir and stat instead of rejecting', async () => {
    // The freshness walk runs on every 60s cycle ahead of the usage, Ledger and
    // Projects snapshots. One unreadable entry must not take the whole cycle
    // down with it.
    expect(await safeStatMtimeMs(path.join(root, 'gone.jsonl'))).toBeNull();
  });

  it('returns the mtime for a file that does exist', async () => {
    const when = new Date('2026-08-05T10:00:00Z');
    await writeTranscript('project-a', 'here.jsonl', when);
    expect(await safeStatMtimeMs(path.join(root, 'project-a', 'here.jsonl'))).toBe(when.getTime());
  });

  it('ignores files that are not transcripts', async () => {
    const transcript = new Date('2026-08-01T00:00:00Z');
    await writeTranscript('project-a', 'real.jsonl', transcript);

    const decoy = path.join(root, 'project-a', 'notes.txt');
    await fsp.writeFile(decoy, 'x');
    const later = new Date('2026-08-09T00:00:00Z');
    await fsp.utimes(decoy, later, later);

    expect(await findNewestTranscriptMtimeMs(root)).toBe(transcript.getTime());
  });
});
