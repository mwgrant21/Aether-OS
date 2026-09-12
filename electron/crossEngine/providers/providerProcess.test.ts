// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { spawnProviderProcess, disposeProviderProcess } from './providerProcess';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('provider process containment', () => {
  it.runIf(process.platform === 'win32')('preserves raw stdio and proves a stubborn real descendant has exited', async () => {
    const script = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      console.log(JSON.stringify({pid:process.pid,descendant:child.pid}));
      process.stdin.on('data',data=>process.stdout.write(data));
      setInterval(()=>{},1000);`;
    const child = spawnProviderProcess(process.execPath, ['-e', script], process.env);
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    try {
      const [first] = await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'close').then(() => { throw new Error('host closed before ready: ' + stderr); }),
      ]);
      const ids = JSON.parse(String(first)) as { pid: number; descendant: number };
      expect(alive(ids.pid)).toBe(true);
      expect(alive(ids.descendant)).toBe(true);
      const echoed = once(child.stdout, 'data');
      child.stdin.write('raw π payload\n');
      expect(String((await echoed)[0])).toBe('raw π payload\n');
      const one = child.disposeTree();
      expect(child.disposeTree()).toBe(one);
      await one;
      expect(alive(ids.pid)).toBe(false);
      expect(alive(ids.descendant)).toBe(false);
    } finally { await child.disposeTree(); }
  }, 20_000);

  it.runIf(process.platform === 'win32')('reaps descendants after their immediate wrapper has exited', async () => {
    const script = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});
      console.log(child.pid);child.unref();setTimeout(()=>process.exit(0),100);`;
    const child = spawnProviderProcess(process.execPath, ['-e', script], process.env);
    child.stderr.resume();
    const [first] = await once(child.stdout, 'data');
    const descendant = Number(String(first).trim());
    await once(child, 'close');
    await child.disposeTree();
    expect(alive(descendant)).toBe(false);
  }, 20_000);

  it('propagates a failed kill rather than converting it to disposal success', async () => {
    const failure = new Error('job termination denied');
    const child = { disposeTree: async () => { throw failure; } };
    await expect(disposeProviderProcess(child as never)).rejects.toBe(failure);
    await expect(disposeProviderProcess({} as never)).rejects.toThrow('no tree supervisor');
  });

  it('refuses unsupported platforms before starting a provider', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      expect(() => spawnProviderProcess(process.execPath, [], process.env)).toThrow('requires Windows');
    } finally { platform.mockRestore(); }
  });

  it.runIf(process.platform === 'win32')('host crash kills its job but never invents a cleanup receipt', async () => {
    const child = spawnProviderProcess(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], process.env);
    child.stderr.resume();
    const [first] = await once(child.stdout, 'data');
    const root = Number(String(first).trim());
    const closed = once(child, 'close');
    child.kill();
    await closed;
    await expect(child.disposeTree()).rejects.toThrow();
    const deadline = Date.now() + 3000;
    while (alive(root) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(alive(root)).toBe(false);
  }, 20_000);
});
