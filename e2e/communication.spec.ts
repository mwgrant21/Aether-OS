import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { mkdirSync, readFileSync, copyFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

for (const mode of ['flow', 'slow', 'watchdog']) test(`communication real helper and fake provider: ${mode}`, async ({}, testInfo) => {
  test.setTimeout(mode === 'slow' ? 180000 : 45000);
  const root=resolve('.'), fixture=resolve('out/e2e-communication');mkdirSync(fixture,{recursive:true});
  for(const [name,entry] of [['bridge','mainIntegration'],['ipc','ipc']]) buildSync({entryPoints:[resolve(`electron/communicationBridge/${entry}.ts`)],outfile:join(fixture,`${name}.cjs`),bundle:true,platform:'node',format:'cjs',packages:'external',define:{'import.meta.url':JSON.stringify(pathToFileURL(resolve('package.json')).href)},logLevel:'silent'});
  copyFileSync(resolve('e2e/fixtures/communication-main.cjs'),join(fixture,'main.cjs'));
  const output=testInfo.outputPath(mode);mkdirSync(output,{recursive:true});
  const executable=createRequire(import.meta.url)('electron') as string;
  const env: NodeJS.ProcessEnv={...process.env,AETHER_TEST_REPO:root,AETHER_TEST_OUTPUT:output,AETHER_TEST_MODE:mode};delete env.ELECTRON_RUN_AS_NODE;
  const log = openSync(join(output,'stderr.txt'),'w');
  const child=spawn(executable,[join(fixture,'main.cjs')],{windowsHide:true,detached:process.platform!=='win32',env,stdio:['ignore','ignore',log]});
  closeSync(log);
  const exit = new Promise<number|null>((resolveExit,reject)=>{child.once('error',reject);child.once('exit',resolveExit);});
  let timer: ReturnType<typeof setTimeout>;
  async function terminateTree() {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true,timeout:4000});
      if (killed.status !== 0 && child.exitCode === null) throw Error('Could not terminate owned fixture tree');
    } else process.kill(-child.pid, 'SIGKILL');
    let stopTimer: ReturnType<typeof setTimeout>;
    try { await Promise.race([exit, new Promise((_,reject)=>{stopTimer=setTimeout(()=>reject(Error('Fixture exit unconfirmed')),5000);})]); }
    finally { clearTimeout(stopTimer!); }
  }
  try {
    const code=await Promise.race([exit,new Promise<'watchdog'>(resolveTimeout=>{timer=setTimeout(()=>resolveTimeout('watchdog'),mode==='slow'?165000:mode==='watchdog'?15000:35000);})]);
    if (code === 'watchdog') {
      if(mode==='watchdog') {
        const before=JSON.parse(readFileSync(join(output,'progress.json'),'utf8'));
        expect(before.providerPids.length).toBeGreaterThan(0);expect(before.helperPids.length).toBeGreaterThan(0);
        for(const pid of [...before.providerPids,...before.helperPids]) expect(()=>process.kill(pid,0)).not.toThrow();
      }
      await terminateTree();
      expect(mode, 'parent watchdog fired before Playwright timeout').toBe('watchdog');
      const progress=JSON.parse(readFileSync(join(output,'progress.json'),'utf8'));
      expect(progress.providerPids.length).toBeGreaterThan(0);
      for(const pid of [...progress.providerPids,...progress.helperPids]) {
        await expect.poll(()=>{try{process.kill(pid,0);return false;}catch{return true;}}).toBe(true);
      }
      await testInfo.attach('watchdog-descendants-exited',{body:JSON.stringify(progress),contentType:'application/json'});
      return;
    }
    const evidence=JSON.parse(readFileSync(join(output,'evidence.json'),'utf8'));await testInfo.attach('communication-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
    expect(evidence,evidence.error).toHaveProperty('verdict','Passed');expect(code).toBe(0);
  } finally {clearTimeout(timer!);await terminateTree();}
});
