import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 30_000;
const powershell = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";

/** A grant to someone other than the user or SYSTEM, left in place and reported (issue #99). */
export interface ExtraGrant {
  /** '.' for the directory itself, else the top-level entry's name. */
  path: string;
  who: string;
  type: string;
  rights: string;
}

export interface PrivateDirReport {
  /** True when this run tightened the ACL (Windows) or a mode (POSIX). */
  changed: boolean;
  extras: ExtraGrant[];
}

// docs/privacy-and-data.md §7. The Windows half gives the directory an
// explicit, protected ACL: the user and SYSTEM with full control, inherited by
// everything below it, and the profile's inherited entries (Administrators and
// the like) dropped. It never removes an explicit grant someone else added,
// because the one seen in practice is the Codex sandbox group, and Aether runs
// Codex out of codex-home here. Those grants are reported instead, so a
// widened directory is visible rather than silently tolerated. It only writes
// when something is missing: a DACL write re-propagates to every child.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$sidType=[Security.Principal.SecurityIdentifier]',
  '$me=[Security.Principal.WindowsIdentity]::GetCurrent().User',
  "$sys=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
  'function Has-Full($acl,$sid){',
  '  foreach($r in $acl.GetAccessRules($true,$false,$sidType)){',
  "    if($r.IdentityReference.Value -eq $sid.Value -and $r.AccessControlType -eq 'Allow' -and",
  '       ([int]$r.FileSystemRights -band 2032127) -eq 2032127 -and ([int]$r.InheritanceFlags -band 3) -eq 3 -and',
  '       [int]$r.PropagationFlags -eq 0){return $true}',
  '  }',
  '  return $false',
  '}',
  'function Name($sid){ try { $sid.Translate([Security.Principal.NTAccount]).Value } catch { $sid.Value } }',
  'function Report($label,$acl,$inherited){',
  '  foreach($r in $acl.GetAccessRules($true,$inherited,$sidType)){',
  '    $v=$r.IdentityReference.Value',
  "    if($v -ne $me.Value -and $v -ne 'S-1-5-18'){",
  '      "extra`t" + $label + "`t" + (Name $r.IdentityReference) + "`t" + $r.AccessControlType + "`t" + $r.FileSystemRights',
  '    }',
  '  }',
  '}',
  '$acl=[IO.Directory]::GetAccessControl($p)',
  'if(-not $acl.AreAccessRulesProtected -or -not (Has-Full $acl $me) -or -not (Has-Full $acl $sys)){',
  '  foreach($s in @($me,$sys)){',
  "    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))",
  '  }',
  '  $acl.SetAccessRuleProtection($true,$false)',
  '  [IO.Directory]::SetAccessControl($p,$acl)',
  "  'changed'",
  '}',
  "Report '.' ([IO.Directory]::GetAccessControl($p)) $true",
  // Children inherit the root's ACL; only their own explicit grants can widen them.
  "foreach($c in Get-ChildItem -LiteralPath $p -Force){ Report $c.Name ($c.GetAccessControl('Access')) $false }",
].join('\n');

export function parseWindowsOutput(stdout: string): PrivateDirReport {
  const report: PrivateDirReport = { changed: false, extras: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === 'changed') report.changed = true;
    const parts = line.split('\t');
    if (parts[0] === 'extra' && parts.length === 5) {
      report.extras.push({ path: parts[1], who: parts[2], type: parts[3], rights: parts[4] });
    }
  }
  return report;
}

async function ensureWindows(dir: string): Promise<PrivateDirReport> {
  const script = '$p=' + psQuote(dir) + '\n' + WINDOWS_SCRIPT;
  const { stdout } = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
  });
  return parseWindowsOutput(stdout);
}

// POSIX: 0700 on the directory, then 0700/0600 on its top-level entries so a
// file an older build left at the umask default is tightened too. `dir` is
// already the resolved target; symlinked entries inside it are skipped, since
// chmod would follow them out of the directory.
async function ensurePosix(dir: string): Promise<PrivateDirReport> {
  let changed = false;
  const tighten = async (path: string, mode: number) => {
    const st = await lstat(path);
    if (st.isSymbolicLink() || (st.mode & 0o777) === mode) return;
    await chmod(path, mode);
    changed = true;
  };
  await tighten(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await tighten(join(dir, entry.name), 0o700);
    else if (entry.isFile()) await tighten(join(dir, entry.name), 0o600);
  }
  return { changed, extras: [] };
}

/** Creates `dir` if needed and makes it user-only. Throws on failure; callers log it. */
export async function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): Promise<PrivateDirReport> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // A relocated ~/.aether-os (symlink, or a junction on Windows) is secured at
  // its real target: every read and write goes through the link to it, and
  // securing the link alone leaves the target reachable by its real path.
  const target = await realpath(dir);
  return platform === 'win32' ? ensureWindows(target) : ensurePosix(target);
}
