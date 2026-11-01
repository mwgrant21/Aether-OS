// @vitest-environment node
// End to end: the REAL hub (server, connections, gateway, event log, session supervisor) over a real
// WebSocket on loopback, with the fake `claude` child from __fixtures__/fakeClaude.mjs. Only the bind
// address (loopback instead of the fake tailnet IP), the child executable (via spawnFn, which also records
// what is written to its stdin), the session knobs backoffMs [0] and killGraceMs 500, two gateway knobs
// (maxBytes, permissionTimeoutMs), an in-memory session store and fake network interfaces are injected.
// Scenario 7b reaches into the private ws `_socket` to pause the first client, as voiceHub.test.ts does.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { SessionStorePort, StoredSession } from '../remote/types';
import { createVoiceGateway } from './voiceGateway';
import { createVoiceHub, type VoiceHub } from './voiceHub';
import { createVoiceSession, type VoiceSession } from './voiceSession';
import { startVoiceServer } from './voiceServer';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fakeClaude.mjs');
// The key the fixture really emits, read from the fixture so no secret-shaped literal lives here.
const FIXTURE_TAIL = /'sk-ant-' \+ '([^']+)'/.exec(fs.readFileSync(FIXTURE, 'utf8'))![1];
const FIXTURE_KEY = 'sk-ant-' + FIXTURE_TAIL;

const tailnetIfaces = () => ({ Tailscale: [{ address: '100.64.0.5', family: 'IPv4', internal: false }] }) as any;

type Ev = { t: string; sessionId: string; turnId: string | null; seq: number; [k: string]: any };

function fakeStore(): SessionStorePort {
  let data: StoredSession[] = [];
  return {
    load: () => data.map((s) => ({ ...s })),
    save: async (list: StoredSession[]) => { data = list.map((s) => ({ ...s })); },
  } as SessionStorePort;
}

interface Rig {
  hub: VoiceHub;
  sessions: VoiceSession[];
  children: { child: ChildProcess; stdin: string[] }[];
}

const hubs: VoiceHub[] = [];
const sockets: WebSocket[] = [];
const allChildren: ChildProcess[] = [];

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const h of hubs.splice(0)) await h.stop();
  // A stray fake claude is a defect: give stop() a moment, then kill and fail.
  const strays: number[] = [];
  for (const c of allChildren.splice(0)) {
    if (c.pid === undefined) continue;
    try { await until(() => !alive(c.pid!), 3000); } catch { strays.push(c.pid); try { process.kill(c.pid); } catch { /* gone */ } }
  }
  expect(strays).toEqual([]);
});

function makeRig(opts: { maxBytes?: number; permissionTimeoutMs?: number; maxClients?: number } = {}): Rig {
  const sessions: VoiceSession[] = [];
  const children: Rig['children'] = [];
  const hub = createVoiceHub({
    store: fakeStore(),
    networkInterfaces: tailnetIfaces,
    // The hub picks the (fake) tailnet address, as it must; the wrapper rebinds the real server to loopback.
    startServer: ((o: Parameters<typeof startVoiceServer>[0]) =>
      startVoiceServer({ ...o, host: '127.0.0.1', port: 0 })) as any,
    createSession: ((d: Parameters<typeof createVoiceSession>[0]) => {
      const s = createVoiceSession({
        ...d,
        backoffMs: [0],
        killGraceMs: 500,
        spawnFn: (_args, spawnOpts) => {
          const child = spawn(process.execPath, [FIXTURE], spawnOpts);
          const rec = { child, stdin: [] as string[] };
          const write = child.stdin!.write.bind(child.stdin!);
          (child.stdin as any).write = (chunk: any, ...rest: any[]) => {
            rec.stdin.push(String(chunk));
            return (write as any)(chunk, ...rest);
          };
          children.push(rec);
          allChildren.push(child);
          return child;
        },
      });
      sessions.push(s);
      return s;
    }) as any,
    // maxBytes and permissionTimeoutMs are real gateway deps the hub does not expose; reach them here.
    createGateway: ((d: any) =>
      createVoiceGateway({ ...d, maxBytes: opts.maxBytes, permissionTimeoutMs: opts.permissionTimeoutMs })) as any,
  });
  hubs.push(hub);
  return { hub, sessions, children };
}

function hostPort(address: string): { host: string; port: number } {
  const i = address.lastIndexOf(':');
  return { host: address.slice(0, i), port: Number(address.slice(i + 1)) };
}

function redeem(address: string, code: string): Promise<{ status: number; cookie: string | null }> {
  const { host, port } = hostPort(address);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, method: 'POST', path: '/api/voice/pair', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => {
          const sc = res.headers['set-cookie']?.[0];
          resolve({ status: res.statusCode ?? 0, cookie: sc ? sc.split(';')[0] : null });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ code }));
  });
}

interface Client {
  ws: WebSocket;
  frames: string[];
  events: Ev[];
  closed: Promise<number>;
  send(o: object): void;
  waitFor(pred: (e: Ev) => boolean, ms?: number): Promise<Ev>;
  lastSeq(): number;
}

/**
 * Scripted client. The connection layer HOLDS live events from attach until the client's FIRST inbound
 * frame (spec amendment 2026-11-01), so by default this sends `resume{lastSeq:0}` right after the socket
 * opens; pass `first: null` to send nothing, or another frame to script a reconnect.
 */
async function connect(address: string, cookie: string, first: object | null = { t: 'resume', lastSeq: 0 }): Promise<Client> {
  const ws = new WebSocket(`ws://${address}/voice`, { headers: { Cookie: cookie } });
  sockets.push(ws);
  const frames: string[] = [];
  const events: Ev[] = [];
  ws.on('message', (d) => { const f = String(d); frames.push(f); events.push(JSON.parse(f)); });
  const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const c: Client = {
    ws,
    frames,
    events,
    closed,
    send: (o) => ws.send(JSON.stringify(o)),
    async waitFor(pred, ms = 6000) {
      await until(() => events.some(pred), ms);
      return events.find(pred)!;
    },
    lastSeq: () => events.reduce((m, e) => Math.max(m, e.seq), 0),
  };
  if (first) c.send(first);
  return c;
}

const isReady = (e: Ev) => e.t === 'status' && e.kind === 'session' && e.state === 'ready';
const isDone = (id: string) => (e: Ev) => e.t === 'turn.completed' && e.turnId === id;
/** No secret-key fragment: no `sk-ant-` + alphanumeric, and no 8-character window of the fixture's key tail. */
function expectNoKeyFragment(text: string): void {
  expect(text).not.toMatch(/sk-ant-[A-Za-z0-9]/);
  for (let i = 0; i + 8 <= FIXTURE_TAIL.length; i++) expect(text).not.toContain(FIXTURE_TAIL.slice(i, i + 8));
}
const deltaText = (evs: Ev[], id: string) => evs.filter((e) => e.t === 'response.delta' && e.turnId === id).map((e) => e.text).join('');

async function setup(r: Rig, first: object | null = { t: 'resume', lastSeq: 0 }) {
  await r.hub.setEnabled(true);
  const p = await r.hub.createPairing();
  if (!p.ok) throw new Error('not enabled');
  const res = await redeem(p.address, p.code);
  expect(res.status).toBe(204);
  const cookie = res.cookie!;
  const address = p.address;
  const c = await connect(address, cookie, first);
  return { address, cookie, c };
}

async function ready(c: Client): Promise<void> {
  await c.waitFor(isReady);
}

async function runTurn(c: Client, id: string, text: string): Promise<void> {
  c.send({ t: 'turn.start', turnId: id, text, mode: 'voice' });
  await c.waitFor(isDone(id));
}

/** The user-message contents the fake child received on stdin, in order, across all children. */
const userContents = (r: Rig): string[] =>
  sentTexts(r).map((l) => JSON.parse(l.trim()).message.content as string);
const sentTexts = (r: Rig) => r.children.flatMap((x) => x.stdin).filter((l) => l.includes('"type":"user"'));

describe('voice gateway end to end (scripted client, fake claude)', { timeout: 20000 }, () => {
  it('1. pair, connect, status session, then a full turn with strictly increasing seq', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    const first = await c.waitFor((e) => e.t === 'status');
    expect(first).toMatchObject({ kind: 'session', seq: 0, turnId: null }); // outside the sequence
    await ready(c);
    await runTurn(c, 'turn-0001', 'hello there');
    const mine = c.events.filter((e) => e.turnId === 'turn-0001').map((e) => e.t);
    expect(mine[0]).toBe('turn.started');
    expect(mine.filter((t) => t === 'response.delta').length).toBeGreaterThan(0);
    expect(mine.indexOf('response.spoken_done')).toBeGreaterThan(mine.indexOf('response.delta'));
    expect(mine.at(-1)).toBe('turn.completed');
    expect(c.events.find(isDone('turn-0001'))!.status).toBe('completed');
    const seqd = c.events.filter((e) => e.seq > 0);
    for (let i = 1; i < seqd.length; i++) expect(seqd[i].seq).toBeGreaterThan(seqd[i - 1].seq);
    expect(new Set(c.events.map((e) => e.sessionId)).size).toBe(1);
    expect(r.children).toHaveLength(1); // lazy start: exactly one child
  });

  it('2. [[delim]] speaks first, then response.display carries the detail', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    await runTurn(c, 'turn-0002', '[[delim]] go');
    const t = c.events.filter((e) => e.turnId === 'turn-0002').map((e) => e.t);
    expect(deltaText(c.events, 'turn-0002')).toContain('Sure thing.');
    expect(deltaText(c.events, 'turn-0002')).not.toContain('Detail');
    const disp = c.events.find((e) => e.t === 'response.display')!;
    expect(disp.text).toContain('Detail here.');
    expect(t.indexOf('response.delta')).toBeLessThan(t.indexOf('response.spoken_done'));
    expect(t.indexOf('response.spoken_done')).toBeLessThan(t.indexOf('response.display'));
    expect(t.indexOf('response.display')).toBeLessThan(t.indexOf('turn.completed'));
  });

  it('3. [[secret]] never reaches a client frame, in any chunking, live or replayed', async () => {
    const r = makeRig();
    const { address, cookie, c } = await setup(r);
    await ready(c);
    await runTurn(c, 'turn-0003', '[[secret]] go');
    expect(FIXTURE_TAIL.length).toBeGreaterThanOrEqual(30);
    const all = c.frames.join('\n');
    expect(all).not.toContain(FIXTURE_KEY);
    expect(all).not.toContain('hunter2hunter2');
    expectNoKeyFragment(all);
    const spoken = deltaText(c.events, 'turn-0003');
    expectNoKeyFragment(spoken); // the concatenated spoken text: a key split across two deltas must not survive
    expect(spoken).toContain('[redacted]');
    // Replay leg: a fresh socket resuming from 0 sees the same property over the replayed frames.
    c.ws.terminate();
    await c.closed;
    const b = await connect(address, cookie, { t: 'resume', lastSeq: 0 });
    await b.waitFor(isDone('turn-0003'));
    const replayed = b.frames.join('\n');
    expect(deltaText(b.events, 'turn-0003')).toContain('[redacted]');
    expect(replayed).not.toContain('hunter2hunter2');
    expectNoKeyFragment(replayed);
    expectNoKeyFragment(deltaText(b.events, 'turn-0003'));
  });

  it('3b. a key inside the cancel spokenText is masked in the interrupted completion', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    c.send({ t: 'turn.start', turnId: 'turn-0017', text: '[[slow]] go', mode: 'voice' });
    await c.waitFor((e) => e.t === 'turn.started' && e.turnId === 'turn-0017');
    c.send({ t: 'turn.cancel', turnId: 'turn-0017', spokenText: `heard ${FIXTURE_KEY} end` });
    const done = await c.waitFor(isDone('turn-0017'));
    expect(done.status).toBe('interrupted');
    expectNoKeyFragment(done.spokenText);
    expect(done.spokenText).toContain('[redacted]');
    await runTurn(c, 'turn-0018', 'after');
    expectNoKeyFragment(sentTexts(r).join('\n')); // nor does it reach the child in the next turn's prefix
  });

  it('3c. nothing sequenced is delivered until the client sends its first frame (T5 hold)', async () => {
    const r = makeRig();
    const { c } = await setup(r, null);
    await c.waitFor((e) => e.t === 'status' && e.seq === 0);
    await until(() => r.sessions[0].state() === 'ready');
    await new Promise((res) => setTimeout(res, 300));
    expect(c.events.filter((e) => e.seq > 0)).toEqual([]);
    c.send({ t: 'resume', lastSeq: 0 });
    await c.waitFor((e) => isReady(e) && e.seq > 0);
  });

  it('4. [[slow]] + cancel: no delta after the cancel, one interrupted completion, same child answers the next turn', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    const pid = r.sessions[0].pid();
    c.send({ t: 'turn.start', turnId: 'turn-0004', text: '[[slow]] go', mode: 'voice' });
    await c.waitFor((e) => e.t === 'turn.started' && e.turnId === 'turn-0004');
    c.send({ t: 'turn.cancel', turnId: 'turn-0004', spokenText: 'Sure th' });
    const done = await c.waitFor(isDone('turn-0004'));
    expect(done).toMatchObject({ status: 'interrupted', spokenText: 'Sure th' });
    await new Promise((res) => setTimeout(res, 400)); // the rest of the slow reply would have landed by now
    const evs = c.events.filter((e) => e.turnId === 'turn-0004');
    expect(evs.filter((e) => e.t === 'turn.completed')).toHaveLength(1);
    expect(evs.slice(evs.findIndex((e) => e.t === 'turn.completed') + 1).filter((e) => e.t === 'response.delta')).toEqual([]);
    await runTurn(c, 'turn-0005', 'next');
    expect(userContents(r).filter((x) => x.endsWith('next'))).toEqual(['[interrupted after: "Sure th"] next']);
    expect(deltaText(c.events, 'turn-0005')).toContain('interrupted after');
    await runTurn(c, 'turn-0019', 'third');
    expect(userContents(r).filter((x) => x.includes('third'))).toEqual(['third']); // the prefix is used once
    expect(r.sessions[0].pid()).toBe(pid);
    expect(r.children).toHaveLength(1);
  });

  it('4b. cancel while the child ignores interrupt ([[hang]]): deltas arriving after the cancel are not forwarded', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    c.send({ t: 'turn.start', turnId: 'turn-0006', text: '[[hang]] go', mode: 'voice' });
    await c.waitFor((e) => e.t === 'turn.started' && e.turnId === 'turn-0006');
    c.send({ t: 'turn.cancel', turnId: 'turn-0006', spokenText: 'x' });
    // The fake keeps streaming ~2 s and its speech filter releases a unit once 300 chars are held
    // (~1.7 s in), so a gateway that kept forwarding after the cancel would emit a delta here.
    await c.waitFor(isDone('turn-0006'), 8000);
    expect(c.events.filter((e) => e.t === 'response.delta' && e.turnId === 'turn-0006')).toEqual([]);
    expect(c.events.find(isDone('turn-0006'))!.status).toBe('interrupted');
  });

  it('5. drop mid-[[slow]], reconnect + resume: remaining events once, gapless seq', async () => {
    const r = makeRig();
    const { address, cookie, c: a } = await setup(r);
    await ready(a);
    a.send({ t: 'turn.start', turnId: 'turn-0007', text: '[[slow]] go', mode: 'voice' });
    await a.waitFor((e) => e.t === 'turn.started');
    a.ws.terminate();
    await a.closed;
    const sessionId = a.events[0].sessionId;
    const b = await connect(address, cookie, { t: 'resume', lastSeq: a.lastSeq(), sessionId });
    await b.waitFor(isDone('turn-0007'));
    const seqs = [...a.events, ...b.events].filter((e) => e.seq > 0).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length); // exactly once
    const sorted = [...seqs].sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBe(sorted[i - 1] + 1); // gapless
    expect(b.events.find(isDone('turn-0007'))!.status).toBe('completed');
    expect(r.children).toHaveLength(1);
  });

  it('5b. a resume that fell out of the (tiny) replay buffer gets resume_gap and the lost turn is cancelled', async () => {
    const r = makeRig({ maxBytes: 250 });
    const { address, cookie, c: a } = await setup(r);
    await ready(a);
    a.send({ t: 'turn.start', turnId: 'turn-0008', text: '[[slow]] go', mode: 'voice' });
    await a.waitFor((e) => e.t === 'turn.started');
    a.ws.terminate();
    await a.closed;
    const b = await connect(address, cookie, { t: 'resume', lastSeq: 0 });
    const gap = await b.waitFor((e) => e.t === 'error');
    expect(gap).toMatchObject({ code: 'resume_gap', retryable: true, seq: 0 });
    const done = await b.waitFor(isDone('turn-0008'));
    expect(done.status).toBe('interrupted');
  });

  it('6. [[crash]] mid-turn: error completion, restart with a new pid, next turn works, no re-send', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    const pid1 = r.sessions[0].pid();
    c.send({ t: 'turn.start', turnId: 'turn-0009', text: '[[crash]] boom', mode: 'voice' });
    const done = await c.waitFor(isDone('turn-0009'));
    expect(done.status).toBe('error');
    const err = await c.waitFor((e) => e.t === 'error' && e.code === 'session_restarting');
    const restarting = await c.waitFor((e) => e.t === 'status' && e.state === 'restarting');
    const rdyAgain = await c.waitFor((e) => isReady(e) && e.seq > restarting.seq);
    expect(done.seq).toBeLessThan(err.seq);
    expect(err.seq).toBeLessThan(restarting.seq);
    expect(restarting.seq).toBeLessThan(rdyAgain.seq);
    expect(r.sessions[0].pid()).not.toBeNull();
    expect(r.sessions[0].pid()).not.toBe(pid1);
    await runTurn(c, 'turn-0010', 'after the crash');
    expect(c.events.find(isDone('turn-0010'))!.status).toBe('completed');
    expect(sentTexts(r).filter((l) => l.includes('[[crash]] boom'))).toHaveLength(1);
    expect(r.children).toHaveLength(2);
  });

  it('7. a second connection replaces the first (error replaced, close 4000)', async () => {
    const r = makeRig();
    const { address, cookie, c: a } = await setup(r);
    await ready(a);
    const b = await connect(address, cookie);
    expect(await a.closed).toBe(4000);
    expect(a.events.some((e) => e.t === 'error' && e.code === 'replaced')).toBe(true);
    await b.waitFor((e) => e.t === 'status');
    await runTurn(b, 'turn-0011', 'still works');
    expect(r.children).toHaveLength(1);
  });

  it('7b. a third socket while the replaced first is still closing is refused (503); the second stays live', async () => {
    const r = makeRig();
    const { address, cookie, c: a } = await setup(r);
    await ready(a);
    (a.ws as any)._socket.pause(); // A never answers the close frame, so the server keeps counting it
    const b = await connect(address, cookie);
    await b.waitFor((e) => e.t === 'status');
    await expect(connect(address, cookie)).rejects.toThrow(/503/);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    await runTurn(b, 'turn-0016', 'still mine');
  });

  it('8a. revokeAll closes the socket with 4001', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    await r.hub.revokeAll();
    expect(await c.closed).toBe(4001);
  });

  it('8b. setEnabled(false): socket closed, connection refused, the fake child pid is dead', async () => {
    const r = makeRig();
    const { address, cookie, c } = await setup(r);
    await ready(c);
    const pid = r.sessions[0].pid()!;
    expect(alive(pid)).toBe(true);
    await r.hub.setEnabled(false);
    expect(await c.closed).toBe(1001);
    await until(() => !alive(pid), 4000);
    const { host, port } = hostPort(address);
    const refused = await new Promise<boolean>((resolve) => {
      const req = http.request({ host, port, method: 'GET', path: '/', headers: { Cookie: cookie } }, (res) => { res.resume(); resolve(false); });
      req.on('error', () => resolve(true));
      req.end();
    });
    expect(refused).toBe(true);
  });

  it('9. [[tool]] gives status tool/Bash and no tool input in any frame', async () => {
    const r = makeRig();
    const { c } = await setup(r);
    await ready(c);
    await runTurn(c, 'turn-0012', '[[tool]] go');
    expect(c.events.some((e) => e.t === 'status' && e.kind === 'tool' && e.state === 'Bash')).toBe(true);
    const all = c.frames.join('\n');
    expect(all).not.toContain('"input"');
  });

  describe('10. [[perm]] over the real stdio permission flow', () => {
    it('summary is the short tool: hint line; reply approve:false is denied', async () => {
      const r = makeRig({ permissionTimeoutMs: 5000 });
      const { c } = await setup(r);
      await ready(c);
      c.send({ t: 'turn.start', turnId: 'turn-0013', text: '[[perm]] go', mode: 'voice' });
      const req = await c.waitFor((e) => e.t === 'permission.request');
      expect(req.summary).toBe('Bash: echo hi');
      c.send({ t: 'permission.reply', id: req.id, approve: false });
      await c.waitFor(isDone('turn-0013'));
      expect(deltaText(c.events, 'turn-0013')).toContain('perm: deny');
    });

    it('approve:true is allowed (explicit reply is the only way)', async () => {
      const r = makeRig({ permissionTimeoutMs: 5000 });
      const { c } = await setup(r);
      await ready(c);
      c.send({ t: 'turn.start', turnId: 'turn-0014', text: '[[perm]] go', mode: 'voice' });
      const req = await c.waitFor((e) => e.t === 'permission.request');
      c.send({ t: 'permission.reply', id: req.id, approve: true });
      await c.waitFor(isDone('turn-0014'));
      expect(deltaText(c.events, 'turn-0014')).toContain('perm: allow');
    });

    it('no reply: auto-deny after the injected timeout', async () => {
      const r = makeRig({ permissionTimeoutMs: 300 });
      const { c } = await setup(r);
      await ready(c);
      c.send({ t: 'turn.start', turnId: 'turn-0015', text: '[[perm]] go', mode: 'voice' });
      await c.waitFor((e) => e.t === 'permission.request');
      await c.waitFor(isDone('turn-0015'));
      expect(deltaText(c.events, 'turn-0015')).toContain('perm: deny');
    });
  });
});
