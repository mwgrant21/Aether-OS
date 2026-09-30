import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir, parseWindowsOutput } from './privateDir';

const winOnly = it.skipIf(process.platform !== 'win32');
const posixOnly = it.skipIf(process.platform === 'win32');
const ps = (script: string) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });

describe('ensurePrivateDir', () => {
  let base: string;
  let dir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aether-privdir-'));
    dir = join(base, '.aether-os');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('parses the helper output into a report', () => {
    const out = 'changed\r\nextra\t.\tTITAN\\CodexSandboxUsers\tAllow\tModify, Synchronize\r\nnoise\r\n';
    expect(parseWindowsOutput(out)).toEqual({
      changed: true,
      extras: [{ path: '.', who: 'TITAN\\CodexSandboxUsers', type: 'Allow', rights: 'Modify, Synchronize' }],
    });
  });

  winOnly('creates the directory with a protected ACL of only the user and SYSTEM', async () => {
    const report = await ensurePrivateDir(dir);
    expect(report).toEqual({ changed: true, extras: [] });
    const sids = ps(
      `$a=[IO.Directory]::GetAccessControl('${dir}'); if(-not $a.AreAccessRulesProtected){'unprotected'}; ` +
        `$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | % { $_.IdentityReference.Value }`
    )
      .trim()
      .split(/\r?\n/)
      .sort();
    const me = ps('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim();
    expect(sids).toEqual([me, 'S-1-5-18'].sort());
    // Second run finds nothing to fix and does not rewrite the DACL.
    expect((await ensurePrivateDir(dir)).changed).toBe(false);
  }, 60_000);

  winOnly('keeps and reports an explicit third-party grant instead of stripping it', async () => {
    mkdirSync(dir);
    // BUILTIN\Users (S-1-5-32-545) stands in for the Codex sandbox group.
    ps(`icacls '${dir}' /grant '*S-1-5-32-545:(OI)(CI)(M)' | Out-Null`);
    writeFileSync(join(dir, 'statusline.json'), '{}');
    ps(`icacls '${join(dir, 'statusline.json')}' /grant '*S-1-5-32-545:(R)' | Out-Null`);

    const report = await ensurePrivateDir(dir);
    expect(report.changed).toBe(true);
    // One line per ACE: a grant can be stored as more than one ACE (the CI
    // runner reports two for '.'), so assert which paths carry it, not a count.
    expect([...new Set(report.extras.map((e) => e.path))].sort()).toEqual(['.', 'statusline.json']);
    for (const e of report.extras) expect(e, JSON.stringify(report.extras)).toMatchObject({ who: expect.stringMatching(/Users$/), type: 'Allow' });
    // Still granted afterwards.
    expect(ps(`icacls '${dir}'`)).toMatch(/Users:\(OI\)\(CI\)\(M\)/);
  }, 60_000);

  winOnly('secures the target of a relocated (junctioned) directory', async () => {
    const real = join(base, 'real-aether');
    mkdirSync(real);
    symlinkSync(real, dir, 'junction');

    expect((await ensurePrivateDir(dir)).changed).toBe(true);
    expect(ps(`[IO.Directory]::GetAccessControl('${real}').AreAccessRulesProtected`).trim()).toBe('True');
  }, 60_000);

  posixOnly('secures the target of a relocated (symlinked) directory', async () => {
    const real = join(base, 'real-aether');
    mkdirSync(real);
    chmodSync(real, 0o755);
    symlinkSync(real, dir);

    expect((await ensurePrivateDir(dir)).changed).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o700);
  });

  posixOnly('tightens the directory to 0700 and its top-level entries to 0700/0600', async () => {
    mkdirSync(join(dir, 'spool'), { recursive: true });
    writeFileSync(join(dir, 'collector.db'), '');
    chmodSync(dir, 0o755);
    chmodSync(join(dir, 'spool'), 0o755);
    chmodSync(join(dir, 'collector.db'), 0o644);

    expect((await ensurePrivateDir(dir)).changed).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'spool')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'collector.db')).mode & 0o777).toBe(0o600);
    expect((await ensurePrivateDir(dir)).changed).toBe(false);
  });
});
