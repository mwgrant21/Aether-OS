import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('native Keep open retains cleanup ownership then permits confirmed quit', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Windows native UI Automation');
  const fixture = resolve('out/e2e-quit');
  mkdirSync(fixture, { recursive: true });
  buildSync({ entryPoints: [resolve('electron/communicationBridge/quitGate.ts')], outfile: join(fixture, 'gate.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  copyFileSync(resolve('e2e/fixtures/quit-main.cjs'), join(fixture, 'main.cjs'));
  const output = testInfo.outputPath('native-quit');
  mkdirSync(output, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, AETHER_TEST_OUTPUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [join(fixture, 'main.cjs')], { windowsHide: true, env, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  let termination: Promise<unknown> | undefined;
  const terminateTree = () => termination ??= promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 });
  const watchdog = setTimeout(() => { void terminateTree().catch(() => undefined); }, 22000);
  try {
    const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type 'using System; using System.Runtime.InteropServices; public static class NativeQuitButton { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l); }'
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${child.pid})
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Keep open')
$deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($null -ne $button) {
      $handle = $button.Current.NativeWindowHandle
      if ($handle -eq 0) { throw "Native button has no window handle" }
      [void][NativeQuitButton]::PostMessage([IntPtr]$handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
      Write-Output 'Native Keep open invoked'
      exit 0
    }
  }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Native Keep open button not found for fixture PID'
`;
    const automation = await promisify(execFile)('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 16000 });
    expect(automation.stdout).toContain('Native Keep open invoked');
    expect(await exited).toBe(0);
    const evidence = JSON.parse(readFileSync(join(output, 'evidence.json'), 'utf8'));
    await testInfo.attach('native-quit-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    expect(evidence).toMatchObject({ verdict: 'Passed', response: 1, heldWindowAlive: true, afterDialogWindowAlive: true, waits: 2, cleanQuit: true });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      await terminateTree();
      await exited;
    }
  }
});
