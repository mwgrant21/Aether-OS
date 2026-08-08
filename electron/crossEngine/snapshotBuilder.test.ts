import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildVerificationSnapshot } from './snapshotBuilder';
import type { DispatchEvidence } from './dispatchEvidence';

const execFileAsync = promisify(execFile);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function makeGitRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'aether-snapshot-repo-'));
  cleanups.push(() => rm(repoRoot, { recursive: true, force: true }));

  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });

  await writeFile(join(repoRoot, 'committed.txt'), 'baseline content\n', 'utf8');
  await execFileAsync('git', ['add', 'committed.txt'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoRoot });

  return repoRoot;
}

function evidenceFor(projectRoot: string, touchedFiles: string[]): DispatchEvidence {
  return { toolUseId: 'tu_1', projectRoot, claim: 'did the thing', touchedFiles };
}

describe('buildVerificationSnapshot', () => {
  it('includes the committed baseline plus the current touched-file content', async () => {
    const repoRoot = await makeGitRepo();
    // Modify the committed file after the commit -- the snapshot must reflect
    // the current (uncommitted) content, not the committed baseline alone.
    await writeFile(join(repoRoot, 'committed.txt'), 'edited content\n', 'utf8');

    const snapshot = await buildVerificationSnapshot(evidenceFor(repoRoot, ['committed.txt']));
    cleanups.push(snapshot.dispose);

    const content = await readFile(join(snapshot.snapshotDir, 'committed.txt'), 'utf8');
    expect(content).toBe('edited content\n');
  });

  it('includes touched untracked files not covered by git archive', async () => {
    const repoRoot = await makeGitRepo();
    await mkdir(join(repoRoot, 'src'), { recursive: true });
    await writeFile(join(repoRoot, 'src', 'new-file.ts'), 'export const x = 1;\n', 'utf8');
    // Deliberately not `git add`ed -- git archive HEAD alone would omit it.

    const snapshot = await buildVerificationSnapshot(evidenceFor(repoRoot, ['src/new-file.ts']));
    cleanups.push(snapshot.dispose);

    const content = await readFile(join(snapshot.snapshotDir, 'src', 'new-file.ts'), 'utf8');
    expect(content).toBe('export const x = 1;\n');
  });

  it('represents a deleted touched file as absent from the snapshot', async () => {
    const repoRoot = await makeGitRepo();
    // committed.txt is in the baseline commit; delete it from the working
    // tree without committing the deletion.
    await rm(join(repoRoot, 'committed.txt'));

    const snapshot = await buildVerificationSnapshot(evidenceFor(repoRoot, ['committed.txt']));
    cleanups.push(snapshot.dispose);

    await expect(access(join(snapshot.snapshotDir, 'committed.txt'))).rejects.toThrow();
  });

  it('rejects a touched path that escapes the project root', async () => {
    const repoRoot = await makeGitRepo();

    await expect(
      buildVerificationSnapshot(evidenceFor(repoRoot, ['../../etc/passwd']))
    ).rejects.toThrow(/escapes project root/);
  });

  it('dispose removes the snapshot directory and is idempotent', async () => {
    const repoRoot = await makeGitRepo();
    const snapshot = await buildVerificationSnapshot(evidenceFor(repoRoot, ['committed.txt']));

    await snapshot.dispose();
    await expect(access(snapshot.snapshotDir)).rejects.toThrow();

    // Idempotent: a second dispose() call must not throw.
    await expect(snapshot.dispose()).resolves.toBeUndefined();
  });
});
