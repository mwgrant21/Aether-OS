import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { findNewestTranscriptMtimeMs } from './activeSessionFinder';

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
