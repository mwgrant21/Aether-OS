// @vitest-environment node
// Real-process evidence for the launcher: spawns the BUILT, ESM out/main/pty-owner.js under plain
// node (not Electron) via ensureOwner, drives a real ConPTY shell through ownerClient, then shuts
// the helper down. Gated: AETHER_PTY_LIVE=1 on Windows, and the build must exist; run
// `npx electron-vite build` first. UNEXERCISED here: node-pty resolution from the unpacked asar
// tree of a packaged build (launched as Aether OS.exe + ELECTRON_RUN_AS_NODE=1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOwnerClient } from './ownerClient';
import { ensureOwner } from './ownerLauncher';
import { decodeDiscovery } from './protocol';

const entry = path.resolve('out/main/pty-owner.js');
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== 'win32' || !process.env.AETHER_PTY_LIVE || !fs.existsSync(entry))(
  'ensureOwner with the real built helper', () => {
    let dir = '';
    let discovery = '';
    afterAll(() => {
      // Only the pid the helper recorded for this test's own temp discovery file.
      try {
        const d = decodeDiscovery(fs.readFileSync(discovery, 'utf8'));
        if (d && isAlive(d.pid)) process.kill(d.pid);
      } catch { /* already gone */ }
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('launches, runs a real shell, and shuts down cleanly', async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerlauncher-live-'));
      discovery = path.join(dir, 'd.json');
      const client = createOwnerClient();
      const ok = await ensureOwner({
        client, discoveryPath: discovery, execPath: process.execPath, entryPath: entry,
        fs, isAlive, env: process.env,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), log: () => {},
        launchWaitMs: 15000,
      });
      expect(ok).toBe(true);
      const helperPid = decodeDiscovery(fs.readFileSync(discovery, 'utf8'))!.pid;
      expect(isAlive(helperPid)).toBe(true);

      const e = process.env;
      const env: Record<string, string> = {};
      for (const k of ['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE']) if (e[k] !== undefined) env[k] = e[k]!;
      const pty = client.spawn('terminal2', {
        file: 'powershell.exe', args: [], cwd: os.homedir(), env, cols: 80, rows: 24, writes: ['Write-Output (6*7)\r'],
      }, {});
      let out = '';
      pty.onData((d) => { out += d; });
      pty.resume();
      const end = Date.now() + 20000;
      while (!/\b42\b/.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(out).toMatch(/\b42\b/);

      await client.shutdown();
      const gone = Date.now() + 10000;
      while ((fs.existsSync(discovery) || isAlive(helperPid)) && Date.now() < gone) await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(discovery)).toBe(false);
      expect(isAlive(helperPid)).toBe(false);
    }, 60000);
  },
);
