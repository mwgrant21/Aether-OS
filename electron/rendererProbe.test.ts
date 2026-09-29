import { describe, it, expect, vi, afterEach } from 'vitest';
import { samplePixels, formatProbeLine, withTimeout, createConsoleLimiter, formatConsoleLine } from './rendererProbe';

const fill = (w: number, h: number, px: number[]) => {
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) b.set(px, i * 4);
  return b;
};

describe('samplePixels', () => {
  it('white BGRA buffer -> 5/5', () => {
    expect(samplePixels(fill(8, 8, [255, 255, 255, 255]), 8, 8, 'bgra')).toEqual({ size: '8x8', white: '5/5' });
  });
  it('dark buffer -> 0/5', () => {
    expect(samplePixels(fill(8, 8, [16, 10, 2, 255]), 8, 8, 'bgra').white).toBe('0/5');
  });
  it('0x0 -> size=0x0 without throwing', () => {
    expect(samplePixels(new Uint8Array(0), 0, 0, 'bgra')).toEqual({ size: '0x0', white: '0/5' });
  });
});

describe('formatProbeLine', () => {
  const base = {
    reason: 'unlock-screen' as const, win: 'visible' as const, root: '1', bodyBg: 'rgb(2,10,16)', vis: 'visible',
    canvases: '2', glLost: '0', size: '100x50', white: '0/5', at: 'T',
  };
  it('normal', () => {
    expect(formatProbeLine(base)).toBe(
      '[diag] probe reason=unlock-screen win=visible root=1 bodyBg=rgb(2,10,16) vis=visible canvases=2 glLost=0 size=100x50 white=0/5 at=T'
    );
  });
  it('timeout', () => {
    expect(formatProbeLine({ ...base, root: 'timeout', size: 'capture=timeout' })).toContain('root=timeout');
  });
});

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());
  it('resolves with the value', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
  });
  it('times out', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 100);
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toBe('timeout');
  });
});

describe('createConsoleLimiter', () => {
  it('drops the 21st line in 60s and reports the suppressed count once on reopen', () => {
    const l = createConsoleLimiter();
    for (let i = 0; i < 20; i++) expect(l.admit(i).allow).toBe(true);
    expect(l.admit(21).allow).toBe(false);
    expect(l.admit(22).allow).toBe(false);
    expect(l.admit(60_001)).toEqual({ allow: true, suppressedBefore: 2 });
    expect(l.admit(60_002).suppressedBefore).toBe(0);
  });
});

describe('formatConsoleLine', () => {
  it('uses basename, flattens newlines, caps at 300', () => {
    const line = formatConsoleLine('file:///C:/app/out/renderer/x.js', 12, 'a\nb' + 'z'.repeat(400));
    expect(line.startsWith('[diag] renderer-console level=error src=x.js:12 msg=a b')).toBe(true);
    expect(line.split('msg=')[1].length).toBe(300);
  });
});
