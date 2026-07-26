import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import os from 'node:os';
import { spawnPty } from './ptyManager';
import { scanAllProjects } from './historyScanner';
import { computeWeeklyTokens, computeDailyTokens, computeLiveTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct, computeContextWindow } from '../src/components/dashboard/realUsageMath';
import { createLiveAgentTracker } from './liveAgentTracker';
import { createAttachmentsStore } from './attachmentsStore';
import { clampBoundsToDisplays, loadWindowBounds, saveWindowBounds, type Bounds } from './windowBounds';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const BOUNDS_SAVE_DEBOUNCE_MS = 500;
const boundsFilePath = join(app.getPath('userData'), 'window-bounds.json');
const iconPath = join(__dirname, '../../build/icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(): void {
  const saved = loadWindowBounds(boundsFilePath);
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const clamped = saved ? clampBoundsToDisplays(saved, displays) : null;
  const initialBounds: Bounds = clamped ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const shouldPositionWindow = clamped !== null;
  const shouldMaximize = saved?.isMaximized === true;

  const win = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,
    ...(shouldPositionWindow ? { x: initialBounds.x, y: initialBounds.y } : {}),
    minWidth: 1024,
    minHeight: 700,
    autoHideMenuBar: true,
    frame: false,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
    },
  });
  mainWindow = win;

  if (shouldMaximize) win.maximize();

  win.on('maximize', () => sendToWindow('window:isMaximized', true));
  win.on('unmaximize', () => sendToWindow('window:isMaximized', false));

  let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = (): void => {
    if (win.isMaximized()) return;
    const bounds = win.getBounds();
    saveWindowBounds(boundsFilePath, { ...bounds, isMaximized: false });
  };
  const scheduleSaveBounds = (): void => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(persistBounds, BOUNDS_SAVE_DEBOUNCE_MS);
  };

  win.on('resize', scheduleSaveBounds);
  win.on('move', scheduleSaveBounds);
  win.on('close', () => {
    if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
    const bounds = win.getNormalBounds();
    saveWindowBounds(boundsFilePath, { ...bounds, isMaximized: win.isMaximized() });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason);
    if (mainWindow === win) mainWindow = null;
    if (!isQuitting) createWindow();
  });

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toUpperCase();
    const isDevToolsShortcut = (key === 'I' && input.control && input.shift) || key === 'F12';
    if (isDevToolsShortcut) {
      win.webContents.toggleDevTools();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function sendToWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

const USAGE_SCAN_INTERVAL_MS = 60000;
const AGENT_TICK_INTERVAL_MS = 1000;

async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const now = new Date();
  sendToWindow('usage:snapshot', {
    weeklyTokens: computeWeeklyTokens(events, now),
    dailyTokens: computeDailyTokens(events, now),
    liveTokens: computeLiveTokens(events, now),
    usedThisMonth: computeUsedThisMonth(events, now),
    burnRatePerMin: computeBurnRatePerMin(events, now),
    weekOverWeekPct: computeWeekOverWeekPct(events, now),
    lastScanAt: now.toISOString(),
    ctxUsed: computeContextWindow(events, now),
  });
}

const liveAgentTracker = createLiveAgentTracker(os.homedir());
const attachmentsStore = createAttachmentsStore(join(os.homedir(), '.aether-os', 'attachments'));
let agentTickInFlight = false;

async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow || agentTickInFlight) return;
  agentTickInFlight = true;
  try {
    const { open, completed, work, anomalies, cacheHitRatio } = await liveAgentTracker.tick();
    sendToWindow('agents:snapshot', open);
    if (completed.length) sendToWindow('agents:completed', completed);
    sendToWindow('agents:activeWork', work);
    sendToWindow('agents:anomalies', anomalies);
    sendToWindow('agents:cacheHitRatio', cacheHitRatio);
  } finally {
    agentTickInFlight = false;
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
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

app.on('before-quit', () => {
  isQuitting = true;
});

let activePty: ReturnType<typeof spawnPty> | null = null;

ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  if (activePty) {
    activePty.kill();
    activePty = null;
  }
  activePty = spawnPty(cols, rows);
  liveAgentTracker.notifyPtySpawned(Date.now());
  const sender = event.sender;
  activePty.onData((data) => {
    if (!sender.isDestroyed()) sender.send('pty:data', data);
  });
});

ipcMain.on('pty:write', (_event, input: string) => {
  activePty?.write(input);
});

ipcMain.on('pty:resize', (_event, { cols, rows }: { cols: number; rows: number }) => {
  activePty?.resize(cols, rows);
});

ipcMain.handle('attachments:list', () => attachmentsStore.list());
ipcMain.handle('attachments:add', () => attachmentsStore.add());
ipcMain.handle('attachments:remove', (_event, name: string) => attachmentsStore.remove(name));
ipcMain.handle('attachments:thumbnail', (_event, name: string) => attachmentsStore.thumbnail(name));
ipcMain.handle('attachments:open', (_event, name: string) => attachmentsStore.open(name));

ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:toggleMaximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);
