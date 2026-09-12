import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The completion promise proves containment is empty, not merely that the
 * npm wrapper emitted exit. No PID enumeration or best-effort taskkill. */
export interface ProviderProcess extends ChildProcessWithoutNullStreams {
  disposeTree: () => Promise<void>;
}

// Windows Job membership is inherited by descendants. Launch suspended so even
// the first instruction cannot create an uncontained child. The host remains
// outside the job and writes its receipt ONLY after ActiveProcesses reaches 0.
// Closing the host's sole job handle also kills members if the host crashes;
// without a receipt that emergency cleanup is deliberately not called proven.
const WINDOWS_HOST = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class AetherProviderJob {
 [StructLayout(LayoutKind.Sequential)] struct SI { public int cb; public IntPtr reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct LIMIT { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct EXT { public LIMIT basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref EXT info,int size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,out ACCOUNT info,int size,IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool value) { if(!value) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Run(string exe,string command,string stop,string receipt) {
   IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
   PI child=new PI(); bool assigned=false;
   try {
     EXT limits=new EXT(); limits.basic.flags=0x2000;
     Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EXT))));
     SI si=new SI(); si.cb=Marshal.SizeOf(typeof(SI)); si.flags=0x100;
     si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
     Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref si,out child));
     Check(AssignProcessToJobObject(job,child.process)); assigned=true;
     Check(ResumeThread(child.thread)!=0xffffffff);
     while(!File.Exists(stop) && WaitForSingleObject(child.process,50)==258) {}
     Check(TerminateJobObject(job,1));
     Stopwatch clock=Stopwatch.StartNew();
     while(true) {
       ACCOUNT info; Check(QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
       if(info.active==0) break;
       if(clock.ElapsedMilliseconds>5000) throw new TimeoutException("provider job did not empty");
       Thread.Sleep(20);
     }
     File.WriteAllText(receipt,"empty");
   } finally {
     // Assignment failure leaves a suspended process outside the job.
     if(child.process!=IntPtr.Zero && !assigned) { TerminateProcess(child.process,1); WaitForSingleObject(child.process,5000); }
     if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
     if(child.process!=IntPtr.Zero) CloseHandle(child.process);
     CloseHandle(job);
   }
 }
}
`;

function windowsQuote(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"';
}

export function spawnProviderProcess(executable: string, args: string[], env: NodeJS.ProcessEnv): ProviderProcess {
  // Process groups on POSIX allow descendants to escape with setsid(). They
  // cannot satisfy this adapter's containment proof. Add an equally strong
  // platform supervisor before enabling production spawning elsewhere.
  if (process.platform !== 'win32') throw new Error('provider tree supervision requires Windows');

  const directory = mkdtempSync(join(tmpdir(), 'aether-provider-'));
  const stop = join(directory, 'stop');
  const receipt = join(directory, 'receipt');
  const parameters = Buffer.from(JSON.stringify({ executable, command: [executable, ...args].map(windowsQuote).join(' '), stop, receipt })).toString('base64');
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_HOST}\n'@\n$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${parameters}'))|ConvertFrom-Json\n[AetherProviderJob]::Run($p.executable,$p.command,$p.stop,$p.receipt)`;
  const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env, stdio: 'pipe', windowsHide: true, shell: false }) as ProviderProcess;
  const closed = observeClose(child);
  let cleanup: Promise<void> | undefined;
  child.disposeTree = () => cleanup ??= (async () => {
    writeFileSync(stop, 'stop');
    await bounded(closed);
    // Never infer success from the host's exit code or pipe closure.
    // Failed cleanup retains these payload-free lifecycle files for diagnosis.
    if (readFileSync(receipt, 'utf8') !== 'empty') throw new Error('provider job cleanup was not confirmed');
    rmSync(directory, { recursive: true, force: true });
  })();
  return child;
}

function observeClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise(resolve => { child.once('close', () => resolve()); });
}

async function bounded(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('provider cleanup was not confirmed within 10 seconds')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Injected stdio fakes still have an explicit cleanup contract; real spawns
 * must come from spawnProviderProcess. A missing contract is never success. */
export async function disposeProviderProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const owned = child as Partial<ProviderProcess>;
  if (!owned.disposeTree) throw new Error('provider process has no tree supervisor');
  await owned.disposeTree();
}
