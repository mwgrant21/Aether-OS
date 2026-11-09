// @vitest-environment node
// Real ConPTY evidence for the pty-owner helper: bundles ownerEntry.ts with esbuild (node-pty
// external, output under the repo so node-pty resolves), runs it as a detached plain node child
// and drives it over its real named pipe. Gated: AETHER_PTY_LIVE=1 on Windows.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PROTO, createFrameReader, decodeDiscovery, encodeFrame, newNonce, parseHelperFrame, signProof, verifyProof,
  type HelperFrame,
} from './protocol';

class Conn {
  frames: HelperFrame[] = [];
  closed = false;
  constructor(readonly socket: net.Socket) {
    const reader = createFrameReader((raw) => { const f = parseHelperFrame(raw); if (f) this.frames.push(f); }, () => socket.destroy());
    socket.on('data', (c) => reader.push(c));
    socket.on('error', () => {});
    socket.on('close', () => { this.closed = true; });
  }
  send(o: unknown): void { this.socket.write(encodeFrame(o)); }
  async until(cond: () => boolean, ms = 15000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout; frames=' + JSON.stringify(this.frames.map((f) => f.t)));
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  async next<T extends HelperFrame['t']>(t: T): Promise<Extract<HelperFrame, { t: T }>> {
    await this.until(() => this.frames.some((f) => f.t === t));
    return this.frames.splice(this.frames.findIndex((f) => f.t === t), 1)[0] as Extract<HelperFrame, { t: T }>;
  }
}

async function ownedConn(pipe: string, secret: string): Promise<Conn> {
  const s = await new Promise<net.Socket>((res, rej) => { const k = net.connect(pipe); k.once('error', rej); k.once('connect', () => res(k)); });
  const c = new Conn(s);
  const nonceC = newNonce();
  c.send({ t: 'hello', proto: PROTO, nonceC });
  const ch = await c.next('challenge');
  expect(verifyProof(secret, 'server', nonceC, ch.proofS)).toBe(true);
  c.send({ t: 'auth', proofC: signProof(secret, 'client', ch.nonceS) });
  await c.next('ready');
  c.send({ t: 'claim' });
  await c.next('slots');
  return c;
}

describe.skipIf(process.platform !== 'win32' || !process.env.AETHER_PTY_LIVE)('pty-owner helper with real ConPTY', () => {
  let child: ChildProcess | null = null;
  let dir = '';
  afterAll(() => {
    // Only the PID this test started; a clean shutdown has already exited it.
    if (child?.pid && child.exitCode === null) { try { process.kill(child.pid); } catch { /* gone */ } }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a dropped client: shell output is replayed on reconnect, then shutdown exits 0', async () => {
    const outDir = path.resolve('out/pty-owner-live');
    fs.mkdirSync(outDir, { recursive: true });
    const bundle = path.join(outDir, 'pty-owner.cjs');
    buildSync({
      entryPoints: [path.resolve('electron/ptyOwner/ownerEntry.ts')], outfile: bundle, bundle: true,
      platform: 'node', format: 'cjs', external: ['node-pty'], logLevel: 'silent',
    });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyowner-live-'));
    const discovery = path.join(dir, 'd.json');
    child = spawn(process.execPath, [bundle], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AETHER_PTY_OWNER_DISCOVERY: discovery, AETHER_PTY_OWNER_GRACE_MS: '60000' },
    });
    const exited = new Promise<number | null>((res) => child!.once('exit', res));
    child.unref();

    const end = Date.now() + 15000;
    let disc = null;
    while (!disc && Date.now() < end) {
      disc = decodeDiscovery(fs.existsSync(discovery) ? fs.readFileSync(discovery, 'utf8') : '');
      if (!disc) await new Promise((r) => setTimeout(r, 50));
    }
    expect(disc, 'helper wrote its discovery file').not.toBeNull();
    expect(disc!.pid).toBe(child.pid);

    const a = await ownedConn(disc!.pipe, disc!.secret);
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    a.send({ t: 'spawn', slot: 'terminal2', spec: { file: 'powershell.exe', args: [], cwd: os.homedir(), env, cols: 100, rows: 30, writes: [] }, meta: {} });
    a.send({ t: 'attach', slot: 'terminal2' });
    await a.next('attached');
    a.send({ t: 'write', slot: 'terminal2', d: 'Write-Output (6*7)\r' });
    // ConPTY interleaves cursor/colour escapes with the text; strip them before matching.
    const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    const answer = /\n42\r?\n/;
    await a.until(() => answer.test(plain(a.frames.map((f) => (f.t === 'data' ? f.d : '')).join(''))));

    a.socket.destroy();
    await a.until(() => a.closed);

    const b = await ownedConn(disc!.pipe, disc!.secret);
    b.send({ t: 'attach', slot: 'terminal2' });
    const att = await b.next('attached');
    expect(att.state).toBe('running');
    expect(plain(att.ring.map((c) => c.d).join(''))).toMatch(answer);

    b.send({ t: 'shutdown' });
    expect(await exited).toBe(0);
    expect(fs.existsSync(discovery)).toBe(false);
  }, 60000);
});
