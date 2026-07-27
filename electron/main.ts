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
import { computeCacheHitRate } from '../src/shared/cacheHitRate';
import { loadOptimizeState, recordAppliedAt } from './optimizeState';
import { runChatRequest } from '../src/shared/chatCore';
import { loadDotEnvInto } from './loadDotEnv';
import { startStatuslineWatcher } from './statuslineWatcher';
import { readInstallState, installStatusline, uninstallStatusline } from './statuslineInstaller';
import type { StatuslineSnapshot } from '../src/shared/statuslinePayload';

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

const statuslinePayloadPath = join(os.homedir(), '.aether-os', 'statusline.json');
const statuslineSettingsPath = join(os.homedir(), '.claude', 'settings.json');
// Mirrors the .env resolution above: app.getAppPath() resolves the project
// root in dev, and inside resources/app.asar for a packaged build. Task 3's
// script is not yet wired into packaging (no extraResources config exists in
// this repo), so a packaged build will not find it at this path -- the same
// known gap already called out for .env, not something this task solves.
const statuslineScriptPath = join(app.getAppPath(), 'scripts', 'aether-statusline.mjs');
let stopStatuslineWatcher: (() => void) | null = null;
// The last snapshot the watcher emitted, kept for `statusline:snapshot:current` --
// on the very first `loadURL`/`loadFile`, the watcher's own startup read fires
// before useStatuslineSync's IPC listener has registered, so that push is
// otherwise dropped silently. Caching it here lets the renderer pull it once it
// has mounted, instead of waiting for the next on-disk change (which may never
// come during the current session).
let cachedStatuslineSnapshot: StatuslineSnapshot | null = null;

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
  const cacheHitRate = computeCacheHitRate(events);
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
  // Load .env into process.env before anything downstream (e.g. the chat:send
  // handler below) reads ANTHROPIC_API_KEY. NOTE: in a packaged build,
  // app.getAppPath() resolves inside resources/app.asar, so a .env shipped
  // beside the executable will NOT be found there -- a real shell-exported
  // ANTHROPIC_API_KEY is the supported path for packaged builds, and Task 5's
  // Settings surface must make that legible rather than leaving the user guessing.
  loadDotEnvInto(join(app.getAppPath(), '.env'), process.env);

  Menu.setApplicationMenu(null);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  scanAndPushUsage();
  setInterval(scanAndPushUsage, USAGE_SCAN_INTERVAL_MS);

  tickAndPushAgents();
  setInterval(tickAndPushAgents, AGENT_TICK_INTERVAL_MS);

  stopStatuslineWatcher = startStatuslineWatcher(statuslinePayloadPath, (snapshot) => {
    cachedStatuslineSnapshot = snapshot;
    sendToWindow('statusline:snapshot', snapshot);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (stopStatuslineWatcher) {
    stopStatuslineWatcher();
    stopStatuslineWatcher = null;
  }
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

ipcMain.handle('optimize:apply', async (_event, { findingId, target }: { findingId: string; target: 'global' | 'project' }) => {
  // The renderer picks a target by KIND ('global' | 'project'), never by raw
  // path -- the path is always resolved fresh here from the CURRENT
  // lastScannedEvents, so a picker that's been open for a while (across scan
  // cycles) can't apply against a project path that's gone stale since it was
  // first shown.
  const targetPath = target === 'global' ? optimizeGlobalTargetPath() : optimizeProjectTargetPath(lastScannedEvents);
  if (!targetPath) return { ok: false, error: 'invalid target' };
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
    if (!added) {
      // Already present -- still restart the recurrence clock, per the "Apply
      // always means recurrence check starts now" contract in optimizeState.ts.
      await recordAppliedAt(optimizeStatePath, findingId, Date.now());
      return { ok: true, added: false, alreadyPresent: true, targetPath };
    }

    let backupPath: string | null = null;
    if (fileExisted) {
      backupPath = `${targetPath}.ttbak-${Date.now()}`;
      await fsp.writeFile(backupPath, existing, 'utf8');
    }
    await fsp.mkdir(dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, content, 'utf8');
    // Only record appliedAt once the write has actually succeeded -- otherwise
    // a failed write would still start the recurrence clock and the finding
    // could silently disappear despite CLAUDE.md never being touched.
    await recordAppliedAt(optimizeStatePath, findingId, Date.now());
    return { ok: true, added: true, targetPath, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('statusline:state', () => readInstallState(statuslineSettingsPath, statuslineScriptPath));

// Lets the renderer pull whatever snapshot the watcher last captured -- including
// one read during startup, before any listener existed to receive the pushed
// 'statusline:snapshot' event. Returns null when nothing has been captured yet,
// which is a legitimate "no snapshot" state the renderer already treats as such.
ipcMain.handle('statusline:snapshot:current', () => cachedStatuslineSnapshot);

// Explicit user actions only -- never invoked from any automatic path. The
// renderer names the action; the main process is the only place the script
// and settings paths are ever decided.
ipcMain.handle('statusline:install', () => {
  // This repo has no packaging pipeline (electron:build only, no
  // electron-builder/extraResources config -- see roadmap.md's "what this
  // deliberately does not do"), so statuslineScriptPath always resolves
  // inside the dev project tree today. Still guard on existence rather than
  // assume: if that ever stops being true (packaging added later, or the
  // script is deleted/moved), writing `node "<missing path>"` into the
  // user's REAL ~/.claude/settings.json would break every Claude Code turn,
  // for every project, silently -- refuse instead.
  if (!existsSync(statuslineScriptPath)) {
    return { ok: false, error: `statusline script not found at ${statuslineScriptPath} -- not available in this build` };
  }
  return installStatusline(statuslineSettingsPath, statuslineScriptPath);
});

ipcMain.handle('statusline:uninstall', async () => {
  const result = await uninstallStatusline(statuslineSettingsPath);
  if (result.ok) {
    cachedStatuslineSnapshot = null;
    await fsp.rm(statuslinePayloadPath, { force: true });
  }
  return result;
});

ipcMain.handle('chat:send', async (_event, body: unknown) => {
  const result = await runChatRequest(body, process.env.ANTHROPIC_API_KEY);
  // Deliberately do not surface result.status to the renderer -- askClaude()
  // treats every failure identically, and returning a status would invite a
  // future caller to branch on it and quietly break the null-on-any-failure
  // contract.
  return result.ok ? { reply: result.reply } : { error: result.error };
});

// Returns a boolean only -- never the key, never a prefix, never a length.
// The API key must never reach the renderer.
ipcMain.handle('chat:hasKey', async () => typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0);

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
