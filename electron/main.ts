import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { promises as fsp } from 'fs';
import os from 'node:os';
import { spawnPty } from './ptyManager';
import { scanAllProjects } from './historyScanner';
import { type TranscriptEvent } from './transcriptParser';
import { computeWeeklyTokens, computeDailyTokens, computeLiveTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct, computeContextWindow } from '../src/components/dashboard/realUsageMath';
import { createLiveAgentTracker } from './liveAgentTracker';
import { createAttachmentsStore } from './attachmentsStore';
import { clampBoundsToDisplays, loadWindowBounds, saveWindowBounds, type Bounds } from './windowBounds';
import { evaluateOptimizeRulesWithRecurrence } from '../src/shared/optimizeRules';
import { summarizeOptimize, gradeBreakdown } from '../src/shared/optimizeGrade';
import { guidanceFor, upsertGuidance } from '../src/shared/optimizeActions';
import { loadOptimizeState, recordAppliedAt } from './optimizeState';

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
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const optimizeStatePath = join(os.homedir(), '.aether-os', 'optimize-state.json');
let lastScannedEvents: TranscriptEvent[] = [];

async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  lastScannedEvents = events;
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

  const appliedState = await loadOptimizeState(optimizeStatePath);
  const findings = evaluateOptimizeRulesWithRecurrence(events, WEEK_MS, appliedState);
  const summary = summarizeOptimize(findings);
  let totalCacheRead = 0;
  let totalInput = 0;
  for (const e of events) {
    if (!e.usage) continue;
    totalCacheRead += e.usage.cacheReadInputTokens;
    totalInput += e.usage.inputTokens + e.usage.cacheCreationInputTokens + e.usage.cacheReadInputTokens;
  }
  const cacheHitRate = totalInput > 0 ? totalCacheRead / totalInput : 0;
  const breakdown = gradeBreakdown({ findings, cacheHitRate });
  sendToWindow('optimize:findings', findings);
  sendToWindow('optimize:summary', summary);
  sendToWindow('optimize:breakdown', breakdown);
}

function optimizeGlobalTargetPath(): string {
  return join(os.homedir(), '.claude', 'CLAUDE.md');
}

function optimizeProjectTargetPath(events: TranscriptEvent[]): string | null {
  const withCwd = events
    .filter((e) => e.cwd && e.timestamp)
    .sort((a, b) => b.timestamp!.getTime() - a.timestamp!.getTime());
  return withCwd.length > 0 ? join(withCwd[0].cwd!, 'CLAUDE.md') : null;
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

ipcMain.handle('optimize:targets', async () => {
  const globalPath = optimizeGlobalTargetPath();
  const projectPath = optimizeProjectTargetPath(lastScannedEvents);
  async function pathExists(p: string): Promise<boolean> {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }
  return {
    global: { path: globalPath, exists: await pathExists(globalPath) },
    project: projectPath ? { path: projectPath, exists: await pathExists(projectPath) } : null,
  };
});

ipcMain.handle('optimize:apply', async (_event, { findingId, targetPath }: { findingId: string; targetPath: string }) => {
  const globalPath = optimizeGlobalTargetPath();
  const projectPath = optimizeProjectTargetPath(lastScannedEvents);
  const allowed = targetPath === globalPath || (projectPath !== null && targetPath === projectPath);
  if (!allowed) return { ok: false, error: 'invalid target' };
  if (guidanceFor(findingId) === null) return { ok: false, error: 'unknown finding' };

  try {
    let existing = '';
    let fileExisted = true;
    try {
      existing = await fsp.readFile(targetPath, 'utf8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        existing = '';
        fileExisted = false;
      } else {
        throw err;
      }
    }
    const { content, added } = upsertGuidance(existing, findingId);
    await recordAppliedAt(optimizeStatePath, findingId, Date.now());
    if (!added) return { ok: true, added: false, alreadyPresent: true, targetPath };

    let backupPath: string | null = null;
    if (fileExisted) {
      backupPath = `${targetPath}.ttbak-${Date.now()}`;
      await fsp.writeFile(backupPath, existing, 'utf8');
    }
    await fsp.mkdir(dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, content, 'utf8');
    return { ok: true, added: true, targetPath, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

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
