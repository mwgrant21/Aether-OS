// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headlessPkg from '@xterm/headless';
import { createTrustWatcher, isTrustPromptText, readScreenText, type ScreenBufferLike } from './trustPrompt';

interface HTerm {
  write(d: string, cb?: () => void): void;
  dispose(): void;
  buffer: { active: unknown };
}
const { Terminal } = headlessPkg as unknown as { Terminal: new (o: Record<string, unknown>) => HTerm };

const PROMPT_LINES = [
  'Accessing workspace:',
  '',
  'C:\\Users\\Matt',
  '',
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  'Security guide',
  '',
  '> No, exit',
  '  Yes, I trust this folder',
  '',
  'Enter to confirm · Esc to cancel',
];
const PROMPT = PROMPT_LINES.join('\n');

async function screenOf(chunks: string[], cols: number, rows: number): Promise<{ read: () => string; write: (d: string) => Promise<void>; done: () => void }> {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  const write = (d: string) => new Promise<void>((r) => t.write(d, r));
  for (const c of chunks) await write(c);
  return { read: () => readScreenText(t.buffer.active as ScreenBufferLike, rows), write, done: () => t.dispose() };
}

// Colour the prompt and split it into 7-char chunks (mid-word), CRLF line ends as a pty emits them.
function coloured(): string[] {
  const s = PROMPT_LINES.map((l, i) => (i % 2 === 0 ? `\x1b[1;33m${l}\x1b[0m` : l)).join('\r\n');
  return s.match(/[\s\S]{1,7}/g)!;
}

describe('isTrustPromptText', () => {
  it('is true for the full captured prompt', () => {
    expect(isTrustPromptText(PROMPT)).toBe(true);
  });
  it('tolerates a needle split by newline or spaces, and different case', () => {
    expect(isTrustPromptText('Quick safety\ncheck\nYES, I  TRUST\nTHIS FOLDER')).toBe(true);
  });
  it('is true with only two needles', () => {
    expect(isTrustPromptText('Accessing workspace:\n> No, exit')).toBe(true);
  });
  it('is false with only one needle', () => {
    expect(isTrustPromptText('Yes, I trust this folder')).toBe(false);
    expect(isTrustPromptText('> No, exit')).toBe(false);
  });
  it('is false for ordinary Claude output and for empty text', () => {
    expect(isTrustPromptText('Welcome to Claude Code\n/help for help\ncwd: C:\\Users\\Matt\\proj')).toBe(false);
    expect(isTrustPromptText('I read the file and found the bug. The loop never exits when the list is empty, so I added a guard and a test.')).toBe(false);
    expect(isTrustPromptText('')).toBe(false);
  });
});

describe('detection on a headless xterm screen', () => {
  it('detects the coloured, chunk-split, wrapped prompt; clears on redraw; detects again', async () => {
    const s = await screenOf(coloured(), 40, 40);
    expect(isTrustPromptText(s.read())).toBe(true);
    await s.write('\x1b[2J\x1b[Hwelcome back');
    expect(isTrustPromptText(s.read())).toBe(false);
    await s.write('\x1b[2J\x1b[H' + PROMPT_LINES.join('\r\n'));
    expect(isTrustPromptText(s.read())).toBe(true);
    s.done();
  });

  it('still detects on a short pane (cols 40, rows 8) where the top of the prompt scrolled off', async () => {
    const s = await screenOf(coloured(), 40, 8);
    const text = s.read();
    // The top (Accessing workspace / Quick safety check) is gone; the option lines survive.
    expect(text.toLowerCase()).not.toContain('accessing');
    expect(text).toContain('No, exit');
    expect(text).toContain('I trust this folder');
    expect(isTrustPromptText(text)).toBe(true);
    s.done();
  });
});

describe('readScreenText', () => {
  it('returns empty for an undefined buffer and pads missing rows', () => {
    expect(readScreenText(undefined, 3)).toBe('');
    const buf: ScreenBufferLike = { viewportY: 2, getLine: (y) => (y === 2 ? { translateToString: () => 'a' } : undefined) };
    expect(readScreenText(buf, 2)).toBe('a\n');
  });
});

describe('createTrustWatcher', () => {
  function setup(opts: { detectMs?: number; clearMs?: number } = {}) {
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const changes: boolean[] = [];
    let screen = '';
    const w = createTrustWatcher({
      schedule: (fn, ms) => {
        const t = { fn, ms, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      },
      readScreen: () => screen,
      onChange: (v) => changes.push(v),
      ...opts,
    });
    const fire = (i = timers.length - 1) => {
      if (!timers[i]!.cancelled) timers[i]!.fn();
    };
    return { w, timers, changes, fire, setScreen: (s: string) => (screen = s) };
  }

  it('arms 250 ms on feed and reports the prompt once', () => {
    const h = setup();
    h.setScreen(PROMPT);
    h.w.feed();
    expect(h.timers.map((t) => t.ms)).toEqual([250]);
    h.fire();
    expect(h.changes).toEqual([true]);
  });

  it('uses 1500 ms while shown, stays quiet while the prompt remains, reports false once when cleared', () => {
    const h = setup();
    h.setScreen(PROMPT);
    h.w.feed();
    h.fire(0);
    h.w.feed();
    expect(h.timers[1]!.ms).toBe(1500);
    h.fire(1);
    expect(h.changes).toEqual([true]);
    h.setScreen('> ');
    h.w.feed();
    h.fire(2);
    expect(h.changes).toEqual([true, false]);
  });

  it('detection is a throttle: a pending detect timer is kept across feeds', () => {
    const h = setup();
    h.setScreen(PROMPT);
    h.w.feed();
    h.w.feed();
    h.w.feed();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.cancelled).toBe(false);
  });

  it('clearing is a debounce: a feed while shown cancels the pending clear timer', () => {
    const h = setup();
    h.setScreen(PROMPT);
    h.w.feed();
    h.fire(0);
    h.w.feed();
    h.w.feed();
    expect(h.timers[1]!.cancelled).toBe(true);
    expect(h.timers[2]!.cancelled).toBe(false);
  });

  it('reset cancels the timer and later fires do nothing; dispose cancels and ignores feeds', () => {
    const h = setup();
    h.setScreen(PROMPT);
    h.w.feed();
    h.w.reset();
    expect(h.timers[0]!.cancelled).toBe(true);
    h.fire(0);
    expect(h.changes).toEqual([]);
    h.w.feed();
    expect(h.timers).toHaveLength(2);
    h.w.dispose();
    expect(h.timers[1]!.cancelled).toBe(true);
    h.w.feed();
    expect(h.timers).toHaveLength(2);
  });
});
