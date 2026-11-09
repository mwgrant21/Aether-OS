// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// build/installer.nsh overrides the template's app-running check so a LONE
// leftover helper under $INSTDIR is killed. The template's FIND uses
// `(Get-CimInstance ...).Count`, which is null for one object on PowerShell 5.1.
const nsh = readFileSync(join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
const macro = nsh.slice(nsh.indexOf('!macro customCheckAppRunning'));

describe('installer.nsh customCheckAppRunning (structure)', () => {
  it('defines the macro', () => {
    expect(nsh).toContain('!macro customCheckAppRunning');
  });

  it('runs the default check before the sweep, and the PowerShell probe before both', () => {
    const probe = macro.indexOf('!insertmacro IS_POWERSHELL_AVAILABLE');
    const check = macro.indexOf('!insertmacro _CHECK_APP_RUNNING');
    const sweep = macro.indexOf('AETHER_SWEEP_PS');
    expect(probe).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(probe);
    expect(sweep).toBeGreaterThan(check);
    expect(macro.indexOf('nsExec')).toBeGreaterThan(check);
  });

  it('supplies the include and variable the template skips once the macro is defined', () => {
    const top = nsh.slice(0, nsh.indexOf('!macro customCheckAppRunning'));
    expect(top).toMatch(/^!include "getProcessInfo\.nsh"$/m);
    expect(top).toMatch(/^Var pid$/m);
  });

  it('guards the sweep on the PowerShell path and on the app exe existing in $INSTDIR', () => {
    expect(macro).toContain('${if} $IsPowerShellAvailable == 0');
    expect(macro).toContain('${andIf} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
  });

  it('has a sweep script with no .Count, no taskkill and no kill by image name', () => {
    const ps = sweepScript();
    expect(ps).toContain('@(Get-CimInstance');
    expect(ps).not.toContain('.Count');
    expect(ps).not.toContain('taskkill');
    expect(ps).not.toContain('/IM');
  });
});

function sweepScript(): string {
  const m = /^!define AETHER_SWEEP_PS "(.*)"$/m.exec(nsh);
  if (!m) throw new Error('AETHER_SWEEP_PS not found in build/installer.nsh');
  return m[1].replaceAll('$$', '$');
}

const ps51 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The template's FIND expression, verbatim from allowOnlyOneInstallerInstance.nsh
// (electron-builder 26.15.3), with the INSTDIR placeholder left for the caller.
// Kept here only as a control: if it ever stops failing for one process, a newer
// PowerShell or template changed the premise and this fix should be revisited.
const templateFind = (dir: string) =>
  `if ((Get-CimInstance -ClassName Win32_Process | ? {$_.Path -and $_.Path.StartsWith('${dir}', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }`;

describe.skipIf(process.platform !== 'win32')('the sweep under real Windows PowerShell 5.1', () => {
  let root = '';
  const pids: number[] = [];

  afterEach(async () => {
    const mine = pids.splice(0);
    for (const pid of mine) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    for (const pid of mine) await goneWithin(pid);
    // Windows releases a killed exe's file lock a moment after the process exits.
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    root = '';
  });

  function setup(): string {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'lonehelper-')));
    return root;
  }

  function helper(dir: string, name: string): number {
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, name);
    copyFileSync(process.execPath, exe);
    const child = spawn(exe, ['-e', 'setTimeout(()=>{},120000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    pids.push(child.pid!);
    return child.pid!;
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function goneWithin(pid: number, ms = 5000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !alive(pid);
  }

  // Run exactly as NSIS does: verbatim command line, -C "<script>".
  function run(script: string, env: Record<string, string>) {
    return spawnSync(ps51, ['-NoProfile', '-NonInteractive', '-C', `"${script}"`], {
      windowsVerbatimArguments: true,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  }

  const sweep = (instdir: string, selfPid = process.pid) =>
    run(sweepScript(), { AETHER_INSTDIR: instdir, AETHER_SELF_PID: String(selfPid) });

  it('is runnable (PowerShell 5.1 exists)', () => {
    expect(existsSync(ps51)).toBe(true);
  });

  it('(a) stops nothing and exits 0 when no process is under the directory', () => {
    const inst = join(setup(), 'inst');
    mkdirSync(inst);
    const r = sweep(inst);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('stopped');
  });

  it('(b) stops exactly one helper', async () => {
    const inst = join(setup(), 'inst');
    const pid = helper(join(inst, 'resources'), 'helper1.exe');
    const r = sweep(inst);
    expect(r.status).toBe(0);
    expect(await goneWithin(pid)).toBe(true);
  });

  it('(c) stops two helpers', async () => {
    const inst = join(setup(), 'inst');
    const a = helper(join(inst, 'resources'), 'helper1.exe');
    const b = helper(join(inst, 'resources'), 'helper2.exe');
    const r = sweep(inst);
    expect(r.status).toBe(0);
    expect(await goneWithin(a)).toBe(true);
    expect(await goneWithin(b)).toBe(true);
  });

  it('(d) leaves a sibling-prefix directory and an unrelated directory alone', async () => {
    const base = setup();
    const inst = join(base, 'inst');
    const target = helper(join(inst, 'resources'), 'helper1.exe');
    const sibling = helper(join(base, 'inst-other'), 'helper2.exe');
    const elsewhere = helper(join(base, 'elsewhere'), 'helper3.exe');
    const r = sweep(inst);
    expect(r.status).toBe(0);
    expect(await goneWithin(target)).toBe(true);
    expect(alive(sibling)).toBe(true);
    expect(alive(elsewhere)).toBe(true);
  });

  it('(e) never stops the process whose PID is AETHER_SELF_PID', async () => {
    const inst = join(setup(), 'inst');
    const self = helper(join(inst, 'resources'), 'helper1.exe');
    const r = sweep(inst, self);
    expect(r.status).toBe(0);
    await new Promise((res) => setTimeout(res, 500));
    expect(alive(self)).toBe(true);
  });

  it("(f) handles a single quote in the install path", async () => {
    const inst = join(setup(), "o'brien", 'inst');
    const pid = helper(join(inst, 'resources'), 'helper1.exe');
    const r = sweep(inst);
    expect(r.status).toBe(0);
    expect(await goneWithin(pid)).toBe(true);
  });

  it('control: the template FIND misses exactly one process but sees two', () => {
    const inst = join(setup(), 'inst');
    helper(join(inst, 'resources'), 'helper1.exe');
    const one = run(templateFind(inst), {});
    expect(one.status).toBe(1);
    helper(join(inst, 'resources'), 'helper2.exe');
    const two = run(templateFind(inst), {});
    expect(two.status).toBe(0);
  });
});
