import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, access, symlink } from 'node:fs/promises';
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

  it('rejects a touched path that is a symlink, rather than following it out of the project root', async () => {
    const repoRoot = await makeGitRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), 'aether-snapshot-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, 'secret.txt'), 'do not leak\n', 'utf8');

    const linkPath = join(repoRoot, 'link.txt');
    try {
      await symlink(join(outsideDir, 'secret.txt'), linkPath, 'file');
    } catch (err) {
      // Creating filesystem symlinks on Windows can require an elevated
      // token or Developer Mode -- skip rather than fail the suite when the
      // sandbox doesn't permit it, since the assertion under test is the
      // application logic, not the OS's symlink permission model.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }

    await expect(
      buildVerificationSnapshot(evidenceFor(repoRoot, ['link.txt']))
    ).rejects.toThrow(/symlink/);
  });

  // Security audit 2026-10-04 (snapshotBuilder-intermediate-symlink-escape):
  // the guard above inspects only the final path component. A symlinked
  // DIRECTORY anywhere in the path was followed on both sides.
  // The packaged app resolves `tar` to Windows' System32 bsdtar, which
  // extracts an archived symlink as a real symlink. A Git Bash shell puts MSYS
  // tar first on PATH, and MSYS tar turns the link into a copy, hiding the
  // escape. Pin the app's resolution for these cases; restored after each.
  function useAppTar(): void {
    if (process.platform !== 'win32') return;
    const saved = process.env.PATH;
    const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    process.env.PATH = `${sys32};${saved ?? ''}`;
    cleanups.push(async () => { process.env.PATH = saved; });
  }

  async function commitSymlinkEntry(repoRoot: string, name: string, target: string): Promise<void> {
    // Created through the index, not the filesystem, so the archive carries a
    // real symlink entry regardless of core.symlinks or symlink privilege.
    const hash = (await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['hash-object', '-w', '--stdin'], { cwd: repoRoot }, (err, out) => (err ? reject(err) : resolve(out.trim())));
      child.stdin!.end(target);
    }));
    await execFileAsync('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},${name}`], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'add link'], { cwd: repoRoot });
  }

  it('refuses to write through a symlinked directory that the baseline archive placed in the snapshot', async () => {
    const repoRoot = await makeGitRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), 'aether-snapshot-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, 'victim.txt'), 'orig\n', 'utf8');
    useAppTar();
    await commitSymlinkEntry(repoRoot, 'd', outsideDir);
    // Working tree: a real directory d/ with dispatch-authored content.
    await rm(join(repoRoot, 'd'), { recursive: true, force: true });
    await mkdir(join(repoRoot, 'd'));
    await writeFile(join(repoRoot, 'd', 'victim.txt'), 'new\n', 'utf8');

    await expect(buildVerificationSnapshot(evidenceFor(repoRoot, ['d/victim.txt']))).rejects.toThrow();
    expect(await readFile(join(outsideDir, 'victim.txt'), 'utf8')).toBe('orig\n');
  });

  it('refuses to delete through a symlinked directory that the baseline archive placed in the snapshot', async () => {
    const repoRoot = await makeGitRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), 'aether-snapshot-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, 'victim.txt'), 'orig\n', 'utf8');
    useAppTar();
    await commitSymlinkEntry(repoRoot, 'd', outsideDir);
    // Working tree: d is absent, so the copy fails and the deletion path runs.
    await rm(join(repoRoot, 'd'), { recursive: true, force: true });

    await expect(buildVerificationSnapshot(evidenceFor(repoRoot, ['d/victim.txt']))).rejects.toThrow();
    await expect(access(join(outsideDir, 'victim.txt'))).resolves.toBeUndefined();
  });

  it('refuses to read through a symlinked directory in the project working tree', async () => {
    const repoRoot = await makeGitRepo();
    const outsideDir = await mkdtemp(join(tmpdir(), 'aether-snapshot-outside-'));
    cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
    await writeFile(join(outsideDir, 'secret.txt'), 'do not leak\n', 'utf8');
    // A junction needs no symlink privilege on Windows; it is a plain dir symlink elsewhere.
    await symlink(outsideDir, join(repoRoot, 'e'), 'junction');

    await expect(buildVerificationSnapshot(evidenceFor(repoRoot, ['e/secret.txt']))).rejects.toThrow(/symlink/);
  });

  it('dispose removes the snapshot directory and is idempotent', async () => {
    const repoRoot = await makeGitRepo();
    const snapshot = await buildVerificationSnapshot(evidenceFor(repoRoot, ['committed.txt']));

    await snapshot.dispose();
    await expect(access(snapshot.snapshotDir)).rejects.toThrow();

    // Idempotent: a second dispose() call must not throw.
    await expect(snapshot.dispose()).resolves.toBeUndefined();
  });
  // Every test here builds a real git repo -- `git init`, two `git config`
  // calls, `git add`, `git commit`, then `git archive` inside the snapshot
  // builder. That is the only suite in this repo that spawns real git
  // subprocesses, and process spawn on a cold, shared Windows CI runner is
  // far slower than locally (the whole file runs in ~1s here, but a single
  // test blew the 5s default on CI on 2026-09-08 and went green on rerun
  // with no code change). The suite-level timeout buys headroom for the
  // subprocess cost without raising the global default and blunting real
  // hang detection everywhere else.
}, 30_000);
