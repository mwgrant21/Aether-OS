import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import os from 'node:os';
import { spawnPty } from './ptyManager';
import { scanAllProjects } from './historyScanner';
import { computeWeeklyTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct } from '../src/components/dashboard/realUsageMath';
import { createLiveAgentTracker } from './liveAgentTracker';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
    },
  });
  mainWindow = win;

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

const USAGE_SCAN_INTERVAL_MS = 60000;
const AGENT_TICK_INTERVAL_MS = 1000;

async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const now = new Date();
  mainWindow.webContents.send('usage:snapshot', {
    weeklyTokens: computeWeeklyTokens(events, now),
    usedThisMonth: computeUsedThisMonth(events, now),
    burnRatePerMin: computeBurnRatePerMin(events, now),
    weekOverWeekPct: computeWeekOverWeekPct(events, now),
    lastScanAt: now.toISOString(),
  });
}

const liveAgentTracker = createLiveAgentTracker(join(os.homedir(), '.claude', 'projects'));
let agentTickInFlight = false;

async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow || agentTickInFlight) return;
  agentTickInFlight = true;
  try {
    const dispatches = await liveAgentTracker.tick();
    mainWindow.webContents.send('agents:snapshot', dispatches);
  } finally {
    agentTickInFlight = false;
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  scanAndPushUsage();
  setInterval(scanAndPushUsage, USAGE_SCAN_INTERVAL_MS);

  tickAndPushAgents();
  setInterval(tickAndPushAgents, AGENT_TICK_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let activePty: ReturnType<typeof spawnPty> | null = null;

ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  if (activePty) {
    activePty.kill();
    activePty = null;
  }
  activePty = spawnPty(cols, rows);
  activePty.onData((data) => {
    event.sender.send('pty:data', data);
  });
});

ipcMain.on('pty:write', (_event, input: string) => {
  activePty?.write(input);
});

ipcMain.on('pty:resize', (_event, { cols, rows }: { cols: number; rows: number }) => {
  activePty?.resize(cols, rows);
});
