// Component harness only: actual helper/bridge/renderer; deterministic PTY and provider.
const { app, BrowserWindow, ipcMain } = require('electron');
const { CommunicationBridgeIntegration } = require('./bridge.cjs');
const { registerCommunicationIpc } = require('./ipc.cjs');
const { PtyLifecycle } = require('./lifecycle.cjs');
const { ConnectedPromptObserver } = require('./observer.cjs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const fs = require('node:fs');
const path = require('node:path');
const repo = process.env.AETHER_TEST_REPO, root = process.env.AETHER_TEST_OUTPUT;
if (!repo || !root) throw Error('Missing isolated fixture configuration');
app.setPath('userData', path.join(root, 'profile'));
const evidence = { turns: 0, writes: [], helperPids: [], history: [], tools: [] };
let win, client, pending, activePty;
const helpers = [], terminals = [];
const answer = 'TASK8_ANSWER ' + 'Unicode 😀 "quoted"\\\n'.repeat(1500);
const bridge = new CommunicationBridgeIntegration({
  providerFactory: () => ({
    connect: async () => {}, health: async () => ({ ready: true, authMode: 'subscription' }),
    newSession: async () => 'task8-fixture',
    sendTurn: () => { evidence.turns++; return new Promise(resolve => { pending = resolve; }); },
    cancel: async () => { pending?.({ stopReason: 'cancelled', text: '' }); pending = undefined; },
    dispose: async () => {},
  }),
  onSnapshot: snapshot => {
    evidence.history.push(snapshot);
    fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(snapshot));
    if (win && !win.isDestroyed()) win.webContents.send('communication:snapshot', snapshot);
  },
});
const lifecycle = new PtyLifecycle();
const observer = new ConnectedPromptObserver(lifecycle, bridge);
const prompt = JSON.parse(fs.readFileSync(path.join(repo, 'electron/__fixtures__/trust-prompt-capture.json'), 'utf8'))
  .chunks.map(chunk => chunk.data).join('');
function fixturePty() {
  const pty = { data: () => {}, exit: () => {}, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; },
    kill() { this.exit(); }, write(value) { evidence.writes.push(value); }, resize() {} };
  terminals.push(pty); return pty;
}
async function start() {
  const manifest = await bridge.prepareLaunch();
  observer.start(manifest.launchId, { cols: 100, rows: 30 }, () => (activePty = fixturePty()), {
    onData: data => win.webContents.send('pty:data', data),
    onAlive: () => bridge.observeClient(manifest.launchId, 'running'),
    onExit: () => bridge.observeClient(manifest.launchId, 'exited'),
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'out/main/communication-mcp.js')], stderr: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AETHER_BRIDGE_PIPE: manifest.endpoint,
      AETHER_BRIDGE_CAPABILITY: manifest.capability } });
  client = new Client({ name: 'task8-deterministic-client', version: '1' });
  helpers.push(client);
  const startTransport = transport.start.bind(transport);
  transport.start = () => {
    const started = startTransport();
    if (transport.pid) {
      evidence.helperPids.push(transport.pid);
      fs.writeFileSync(path.join(root, 'helper-pids.json'), JSON.stringify(evidence.helperPids));
    }
    return started;
  };
  await client.connect(transport);
  evidence.tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  return { ok: true };
}
const trusted = event => !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
registerCommunicationIpc(ipcMain, bridge, trusted, { startSession: start });
ipcMain.handle('pty:start', () => { if (!lifecycle.current) throw Error('Ordinary terminal start forbidden'); });
ipcMain.on('pty:write', (_, value) => lifecycle.write(value));
ipcMain.on('pty:resize', (_, { cols, rows }) => observer.resize(cols, rows));
// Test controls stay in Electron main, never in the product preload or renderer.
app.__task8 = {
  snapshot: () => bridge.snapshot(), evidence: () => evidence,
  async tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw Error('MCP result exceeds budget');
    return JSON.parse(result.content[0].text);
  },
  complete() {
    if (!pending) throw Error('No pending provider');
    pending({ stopReason: 'completed', text: answer, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null } });
    pending = undefined;
  },
  command(value) {
    if (value === 'prompt') { observer.resize(100, 30); activePty.data(prompt); }
    else if (value === 'clear') activePty.data('\x1b[2J\x1b[HFixture waiting');
    else if (value === 'exit') activePty.exit();
    else if (value === 'late-old') { terminals[0].data(prompt); terminals[0].exit(); }
    else throw Error('Unknown fixture command');
  },
  async stop() {
    activePty?.kill();
    const outcomes = await Promise.allSettled([...helpers.map(helper => helper.close()), bridge.dispose().then(result => {
      if (!result.ok) throw Error(result.code);
    })]);
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw Error('Fixture shutdown failed');
    return evidence.helperPids;
  },
};
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1400, height: 1000, webPreferences: {
    preload: path.join(repo, 'out/preload/preload.cjs'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(repo, 'out/renderer/index.html'));
});
