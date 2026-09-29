import type { BrowserWindow } from 'electron';

// Issue #22 renderer probe. Captures what DevTools would show, automatically,
// just after an unlock/resume. Diagnosis only: no screenshot or DOM content is
// stored, and nothing here attempts recovery.

export type PixelOrder = 'bgra' | 'rgba';
export type ProbeReason = 'unlock-screen' | 'resume' | 'start';

export const PROBE_TIMEOUT_MS = 3000;

// Must not call getContext on any canvas: that can create a context as a side effect.
const PROBE_JS = `(() => ({
  rootChildren: (document.getElementById('root') || { children: [] }).children.length,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  visibility: document.visibilityState,
  canvases: document.querySelectorAll('canvas').length,
  glLost: document.querySelectorAll('canvas[data-gl-lost]').length
}))()`;

export interface PixelSample {
  size: string; // WxH
  white: string; // n/5
}

export interface ProbeResult {
  reason: ProbeReason;
  win: 'visible' | 'hidden' | 'minimized';
  root: string;
  bodyBg: string;
  vis: string;
  canvases: string;
  glLost: string;
  size: string;
  white: string;
  at: string;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** Sample centre plus the four quarter points; white means every RGB channel >= 250. */
export function samplePixels(buf: Uint8Array, w: number, h: number, order: PixelOrder): PixelSample {
  if (!w || !h || buf.length < w * h * 4) return { size: `${w || 0}x${h || 0}`, white: '0/5' };
  const pts: Array<[number, number]> = [
    [w >> 1, h >> 1],
    [w >> 2, h >> 2],
    [(w * 3) >> 2, h >> 2],
    [w >> 2, (h * 3) >> 2],
    [(w * 3) >> 2, (h * 3) >> 2],
  ];
  const [ri, gi, bi] = order === 'bgra' ? [2, 1, 0] : [0, 1, 2];
  let white = 0;
  for (const [x, y] of pts) {
    const o = (y * w + x) * 4;
    if (buf[o + ri] >= 250 && buf[o + gi] >= 250 && buf[o + bi] >= 250) white++;
  }
  return { size: `${w}x${h}`, white: `${white}/5` };
}

export function formatProbeLine(r: ProbeResult): string {
  return (
    `[diag] probe reason=${r.reason} win=${r.win} root=${r.root} bodyBg=${r.bodyBg} vis=${r.vis} ` +
    `canvases=${r.canvases} glLost=${r.glLost} size=${r.size} white=${r.white} at=${r.at}`
  );
}

/** Rolling-window limiter for forwarded renderer errors. Pure: caller supplies the clock. */
export function createConsoleLimiter(max = 20, windowMs = 60_000) {
  let stamps: number[] = [];
  let suppressed = 0;
  return {
    /** allow=false means drop; suppressedBefore is the drop count to report once when admission resumes. */
    admit(now: number): { allow: boolean; suppressedBefore: number } {
      stamps = stamps.filter((t) => now - t < windowMs);
      if (stamps.length >= max) {
        suppressed++;
        return { allow: false, suppressedBefore: 0 };
      }
      const before = suppressed;
      suppressed = 0;
      stamps.push(now);
      return { allow: true, suppressedBefore: before };
    },
  };
}

export function formatConsoleLine(sourceId: string, lineNumber: number, message: string): string {
  const base = sourceId.split(/[\\/]/).pop() ?? '';
  const msg = message.replace(/[\r\n]+/g, ' ').slice(0, 300);
  return `[diag] renderer-console level=error src=${base}:${lineNumber} msg=${msg}`;
}

export async function runRendererProbe(
  win: BrowserWindow | null | undefined,
  reason: ProbeReason,
  write: (line: string) => void
): Promise<void> {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const winState = win.isMinimized() ? 'minimized' : win.isVisible() ? 'visible' : 'hidden';
    const r: ProbeResult = {
      reason,
      win: winState,
      root: 'n/a',
      bodyBg: 'n/a',
      vis: 'n/a',
      canvases: 'n/a',
      glLost: 'n/a',
      size: 'n/a',
      white: 'n/a',
      at: new Date().toISOString(),
    };
    try {
      const dom = await withTimeout(win.webContents.executeJavaScript(PROBE_JS), PROBE_TIMEOUT_MS);
      if (dom === 'timeout') {
        r.root = 'timeout';
      } else {
        r.root = String(dom.rootChildren);
        r.bodyBg = String(dom.bodyBg).replace(/\s+/g, '');
        r.vis = String(dom.visibility);
        r.canvases = String(dom.canvases);
        r.glLost = String(dom.glLost);
      }
    } catch (err) {
      r.root = `error:${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`;
    }
    try {
      const img = await withTimeout(win.webContents.capturePage(), PROBE_TIMEOUT_MS);
      if (img === 'timeout') {
        r.size = 'capture=timeout';
      } else {
        const { width, height } = img.getSize();
        // toBitmap is BGRA on Windows; its format is platform-dependent elsewhere.
        const s = samplePixels(img.toBitmap(), width, height, process.platform === 'win32' ? 'bgra' : 'rgba');
        r.size = s.size;
        r.white = s.white;
      }
    } catch {
      r.size = 'capture=error';
    }
    write(formatProbeLine(r));
  } catch {
    // diagnostics must never take the main process down
  }
}
