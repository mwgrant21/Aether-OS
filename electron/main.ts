import { app, BrowserWindow, ipcMain, Menu, screen, nativeImage } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { promises as fsp } from 'fs';
import os from 'node:os';
import { spawnPty } from './ptyManager';
import { scanAllProjects } from './historyScanner';
import { type TranscriptEvent } from './transcriptParser';
import { readUsageEventsSince, readFleetSessions, readDiagnostics, type CollectorUsageEvent } from './collectorStore';
import { computeWeeklyTokens, computeDailyTokens, computeLiveTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct, computeContextWindow } from '../src/components/dashboard/realUsageMath';
import { createLiveAgentTracker, type LiveAgentTick } from './liveAgentTracker';
import { createEmptyAccumulator, accumulate, type RecapAccumulator } from './recapAccumulator';
import { writeOwnSessionFile, readOwnSessionId, ownSessionFilePath } from './ownSessionFile';
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
import { startPermissionServer, type PermissionDecision, type PostToolFlagDecision } from './permissionServer';
import { classifyPermissionRisk } from '../src/shared/permissionRisk';
import { derivePermissionEditableField } from '../src/shared/permissionEditableField';
import { renderNotificationBadge } from './notificationBadge';
import net from 'node:net';
import crypto from 'node:crypto';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let isWindowFocused = true;
let unfocusedNotificationCount = 0;
let recapAcc: RecapAccumulator = createEmptyAccumulator();
let prevTickForRecap: LiveAgentTick | null = null;

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

  win.on('focus', () => {
    isWindowFocused = true;
    unfocusedNotificationCount = 0;
    win.flashFrame(false);
    win.setOverlayIcon(null, '');
    if (recapAcc.entries.length > 0 || recapAcc.tokensBurned > 0) {
      sendToWindow('presence:recap', recapAcc);
    }
    recapAcc = createEmptyAccumulator();
  });
  win.on('blur', () => {
    isWindowFocused = false;
  });

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
const FLEET_SCAN_INTERVAL_MS = 15000;
const DIAGNOSTICS_SCAN_INTERVAL_MS = 15000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const optimizeStatePath = join(os.homedir(), '.aether-os', 'optimize-state.json');
const collectorDbPath = join(os.homedir(), '.aether-os', 'collector.db');

const statuslinePayloadPath = join(os.homedir(), '.aether-os', 'statusline.json');
const permissionServerPortPath = join(os.homedir(), '.aether-os', 'permission-server-port');
const aetherOsDir = join(os.homedir(), '.aether-os');
const statuslineSettingsPath = join(os.homedir(), '.claude', 'settings.json');
// Mirrors the .env resolution above: app.getAppPath() resolves the project
// root in dev, and inside resources/app.asar for a packaged build. Task 3's
// script is not yet wired into packaging (no extraResources config exists in
// this repo), so a packaged build will not find it at this path -- the same
// known gap already called out for .env, not something this task solves.
const statuslineScriptPath = join(app.getAppPath(), 'scripts', 'aether-statusline.mjs');
let stopStatuslineWatcher: (() => void) | null = null;
let stopPermissionServer: (() => void) | null = null;

// requestId -> resolver for a permission request currently awaiting the
// renderer's decision. Populated in onPermissionRequest below, drained by
// the 'permission:respond' handler.
const pendingPermissionResolvers = new Map<string, (decision: PermissionDecision) => void>();

// requestId -> resolver for an anomaly-triggered PostToolUse flag-review
// currently awaiting the renderer's decision. Same pattern as
// pendingPermissionResolvers above, kept as its own map (rather than reusing
// the single-slot pendingPermissionRequest renderer state) so a flag-review
// can't collide with a concurrent, unrelated PermissionRequest card.
const pendingPostToolFlagResolvers = new Map<string, (decision: PostToolFlagDecision) => void>();

// Both pending-resolver maps above have the same latent leak: permissionServer.ts's
// own withTimeout resolves the HTTP response independently on timeout, without
// ever calling back into these maps, so a timed-out request's resolver is never
// removed -- a slow, session-lifetime leak of one Function reference per timeout.
// Schedule a matching cleanup so a stale entry can't outlive the server-side
// timeout that already made it moot.
function scheduleResolverCleanup<T>(map: Map<string, (decision: T) => void>, requestId: string, afterMs: number): void {
  setTimeout(() => map.delete(requestId), afterMs + 1000).unref();
}

// startPermissionServer's own promise only ever resolves on the underlying
// server's 'listening' event -- it does not reject on 'error' (e.g.
// EADDRINUSE), so awaiting it directly on a busy port would hang app launch
// forever. Probe the desired port with a throwaway net server first so a
// conflict (a second Aether instance, or a leftover process) falls back to an
// ephemeral port instead of ever blocking startup -- mirrors this project's
// "never let infra startup crash the whole app" convention (see the
// statusline watcher's own defensive design).
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port);
  });
}
// The last snapshot the watcher emitted, kept for `statusline:snapshot:current` --
// on the very first `loadURL`/`loadFile`, the watcher's own startup read fires
// before useStatuslineSync's IPC listener has registered, so that push is
// otherwise dropped silently. Caching it here lets the renderer pull it once it
// has mounted, instead of waiting for the next on-disk change (which may never
// come during the current session).
let cachedStatuslineSnapshot: StatuslineSnapshot | null = null;

async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const now = new Date();

  // Dashboard tiles: prefer the collector's incrementally-tailed usage_events
  // store; only fall back to a full re-scan of every project's transcripts
  // when the collector hasn't run yet, isn't installed, or its schema
  // predates this stage -- Aether OS must stay fully usable either way
  // (docs/roadmap.md SS4.6).
  const sinceMs = now.getTime() - 31 * 24 * 60 * 60 * 1000; // covers computeUsedThisMonth's widest window with margin
  const collectorEvents = readUsageEventsSince(collectorDbPath, sinceMs);

  // CollectorUsageEvent is intentionally narrower than TranscriptEvent (no
  // sessionId/cwd/toolUses -- Task 2's scope cut). realUsageMath.ts's 7
  // functions only ever read .kind/.timestamp/.usage (confirmed by reading
  // every one during this plan's research), so this cast is safe for THIS
  // call site (the dashboard-tile block below) ONLY -- but a future
  // realUsageMath function reading any other field would silently break
  // against the collector path. Don't add one without widening
  // CollectorUsageEvent and readUsageEventsSince's SELECT first.
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const usageEvents: TranscriptEvent[] =
    collectorEvents !== null
      ? (collectorEvents as unknown as TranscriptEvent[])
      : await scanAllProjects(projectsRoot);

  sendToWindow('usage:snapshot', {
    weeklyTokens: computeWeeklyTokens(usageEvents, now),
    dailyTokens: computeDailyTokens(usageEvents, now),
    liveTokens: computeLiveTokens(usageEvents, now),
    usedThisMonth: computeUsedThisMonth(usageEvents, now),
    burnRatePerMin: computeBurnRatePerMin(usageEvents, now),
    weekOverWeekPct: computeWeekOverWeekPct(usageEvents, now),
    lastScanAt: now.toISOString(),
    ctxUsed: computeContextWindow(usageEvents, now),
  });

  // Optimize's rules need toolUses/toolResults (opus-on-trivial-turns needs
  // model; unpinned-config-re-reads and uncapped-bash-output need tool call/
  // result detail) -- CollectorUsageEvent deliberately does not carry any of
  // that (Task 2's privacy-minimal scope cut), so this MUST be a genuine,
  // unconditional scanAllProjects() call, never the collector-sourced
  // usageEvents above. This is unchanged from pre-Stage-3 behavior --
  // Optimize was never part of what this stage moved to the collector.
  const optimizeEvents = await scanAllProjects(projectsRoot);
  const appliedState = await loadOptimizeState(optimizeStatePath);
  const findings = evaluateOptimizeRulesWithRecurrence(optimizeEvents, WEEK_MS, appliedState);
  const summary = summarizeOptimize(findings);
  const cacheHitRate = computeCacheHitRate(optimizeEvents);
  const breakdown = gradeBreakdown({ findings, cacheHitRate });
  sendToWindow('optimize:findings', findings);
  sendToWindow('optimize:summary', summary);
  sendToWindow('optimize:breakdown', breakdown);
}

function scanAndPushFleet(): void {
  if (!mainWindow) return;
  const rows = readFleetSessions(collectorDbPath);
  sendToWindow('fleet:snapshot', rows);
}

function scanAndPushDiagnostics(): void {
  if (!mainWindow) return;
  const snapshot = readDiagnostics(collectorDbPath, Date.now() - 24 * 60 * 60 * 1000);
  sendToWindow('diagnostics:snapshot', snapshot);
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
let lastWrittenOwnSessionId: string | null | undefined = undefined;

async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow || agentTickInFlight) return;
  agentTickInFlight = true;
  try {
    const result = await liveAgentTracker.tick();
    const { open, completed, work, anomalies, cacheHitRatio } = result;

    if (!isWindowFocused) {
      recapAcc = accumulate(recapAcc, result, prevTickForRecap ?? result, Date.now());
    }
    prevTickForRecap = result;

    const pinnedSessionId = liveAgentTracker.getPinnedSessionId();
    if (pinnedSessionId !== lastWrittenOwnSessionId) {
      writeOwnSessionFile(aetherOsDir, pinnedSessionId, Date.now());
      lastWrittenOwnSessionId = pinnedSessionId;
    }

    sendToWindow('agents:snapshot', open);
    if (completed.length) sendToWindow('agents:completed', completed);
    sendToWindow('agents:activeWork', work);
    sendToWindow('agents:anomalies', anomalies);
    sendToWindow('agents:cacheHitRatio', cacheHitRatio);
  } finally {
    agentTickInFlight = false;
  }
}

app.whenReady().then(async () => {
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

  scanAndPushUsage().catch((err) => console.error('scanAndPushUsage failed:', err));
  setInterval(() => {
    scanAndPushUsage().catch((err) => console.error('scanAndPushUsage failed:', err));
  }, USAGE_SCAN_INTERVAL_MS);

  tickAndPushAgents();
  setInterval(tickAndPushAgents, AGENT_TICK_INTERVAL_MS);

  scanAndPushFleet();
  setInterval(scanAndPushFleet, FLEET_SCAN_INTERVAL_MS);

  scanAndPushDiagnostics();
  setInterval(scanAndPushDiagnostics, DIAGNOSTICS_SCAN_INTERVAL_MS);

  stopStatuslineWatcher = startStatuslineWatcher(statuslinePayloadPath, (snapshot) => {
    cachedStatuslineSnapshot = snapshot;
    sendToWindow('statusline:snapshot', snapshot);
  });

  const desiredPort = 51823; // arbitrary fixed high port; bump-on-conflict handled below
  const portAvailable = await isPortAvailable(desiredPort);
  const permissionServerOptions = {
    port: portAvailable ? desiredPort : 0,
    timeoutMs: 120000,
    onPermissionRequest: async (req: { toolName: string; toolInput: unknown }): Promise<PermissionDecision> => {
      // Bridges the permission server's request to the renderer and back.
      // This resolution map lives here (not in permissionServer.ts) because
      // it's specifically about the renderer round-trip, not the HTTP server
      // itself -- permissionServer.ts's own withTimeout already covers the
      // "no decision in time" case around this call.
      if (!mainWindow) return { behavior: 'deny', reason: 'no window available to prompt for permission' };
      const requestId = crypto.randomUUID();
      const risk = classifyPermissionRisk(req.toolName, req.toolInput);
      const editableField = derivePermissionEditableField(req.toolName, req.toolInput);
      const decision = new Promise<PermissionDecision>((resolve) => {
        pendingPermissionResolvers.set(requestId, resolve);
      });
      scheduleResolverCleanup(pendingPermissionResolvers, requestId, permissionServerOptions.timeoutMs);
      sendToWindow('permission:request', { requestId, toolName: req.toolName, toolInput: req.toolInput, risk, editableField });
      return decision;
    },
    postToolUseTimeoutMs: 30000,
    onPostToolUse: async (req: { toolUseId: string; toolName: string; toolOutput: unknown }): Promise<PostToolFlagDecision> => {
      // Zero added latency on clean calls: only push a flag-review card (and
      // await the user) when this tick's anomaly detectors actually tripped
      // for this specific tool_use_id -- everything else falls through to an
      // immediate, unblocked allow.
      const tick = await liveAgentTracker.tick();
      const tripped = tick.anomalies.find((a) => a.toolUseId === req.toolUseId);
      if (!tripped) return { block: false };
      if (!mainWindow) return { block: false, reason: 'no window available to prompt for flag review' };

      const requestId = crypto.randomUUID();
      const decision = new Promise<PostToolFlagDecision>((resolve) => {
        pendingPostToolFlagResolvers.set(requestId, resolve);
      });
      scheduleResolverCleanup(pendingPostToolFlagResolvers, requestId, permissionServerOptions.postToolUseTimeoutMs);
      sendToWindow('postToolFlag:request', {
        requestId,
        toolUseId: req.toolUseId,
        toolName: req.toolName,
        anomalyKind: tripped.kind,
        detail: tripped.detail,
      });
      return decision;
    },
    onNotification: ({ sessionId, notificationType }: { sessionId: string; notificationType: string }) => {
      if (sessionId !== readOwnSessionId(ownSessionFilePath(aetherOsDir))) return; // fleet noise, not us
      if (isWindowFocused) return; // suppression rule: true no-op while focused
      unfocusedNotificationCount += 1;
      if (!mainWindow) return;
      mainWindow.flashFrame(true);
      const badge = renderNotificationBadge(16);
      mainWindow.setOverlayIcon(
        nativeImage.createFromBuffer(badge.buffer, { width: badge.width, height: badge.height }),
        `${unfocusedNotificationCount} notification${unfocusedNotificationCount === 1 ? '' : 's'} while away`
      );
      sendToWindow('agents:notification', { reason: notificationType });
    },
  };
  let permission;
  try {
    permission = await startPermissionServer(permissionServerOptions);
  } catch (err) {
    // The probe above narrows the window but can't close it (TOCTOU: another
    // process can grab the port between the probe's close() and this call's
    // listen()). permissionServer.ts now rejects on a real bind failure
    // instead of crashing the process -- retry once on an ephemeral port so
    // app launch never fails over a port conflict either way.
    console.error('startPermissionServer failed on desired port, retrying on an ephemeral port:', err);
    permission = await startPermissionServer({ ...permissionServerOptions, port: 0 });
  }
  stopPermissionServer = permission.stop;
  await fsp.mkdir(dirname(permissionServerPortPath), { recursive: true });
  await fsp.writeFile(permissionServerPortPath, String(permission.port), 'utf8');
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
  if (stopPermissionServer) {
    stopPermissionServer();
    stopPermissionServer = null;
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
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const projectPath = optimizeProjectTargetPath(events);
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

ipcMain.handle('permission:respond', (_event, { requestId, decision }: { requestId: string; decision: PermissionDecision }) => {
  const resolve = pendingPermissionResolvers.get(requestId);
  if (!resolve) return; // already timed out / resolved / duplicate response
  pendingPermissionResolvers.delete(requestId);
  resolve(decision);
});

ipcMain.handle('postToolFlag:respond', (_event, { requestId, decision }: { requestId: string; decision: PostToolFlagDecision }) => {
  const resolve = pendingPostToolFlagResolvers.get(requestId);
  if (!resolve) return; // already timed out / resolved / duplicate response
  pendingPostToolFlagResolvers.delete(requestId);
  resolve(decision);
});

ipcMain.handle('optimize:apply', async (_event, { findingId, target }: { findingId: string; target: 'global' | 'project' }) => {
  // The renderer picks a target by KIND ('global' | 'project'), never by raw
  // path -- the path is always resolved fresh here via an on-demand scan, so
  // a picker that's been open for a while can't apply against a project path
  // that's gone stale since it was first shown.
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const targetPath = target === 'global' ? optimizeGlobalTargetPath() : optimizeProjectTargetPath(events);
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
