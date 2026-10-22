// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_CSS,
  PAIR_HTML,
  PAIR_JS,
  REMOTE_ASSETS,
  VIEWER_HTML,
  VIEWER_JS,
  contentSecurityPolicy,
} from './remotePages';

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sends: unknown[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: unknown): void {
    this.sends.push(d);
  }
  close(): void {}
  open(): void {
    this.onopen?.();
  }
  push(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(): void {
    this.onclose?.();
  }
}

function bodyOf(html: string): string {
  // Parse, then drop script elements from the tree: no regex tag filtering to get wrong.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  return doc.body.innerHTML;
}
function msg(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { k: 'msg', id, atMs: 1_700_000_000_000, role: 'claude', text, truncated: false, tools: [], ...extra };
}
function startViewer(): FakeSocket {
  document.body.innerHTML = bodyOf(VIEWER_HTML);
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  window.eval(VIEWER_JS);
  const s = FakeSocket.all[FakeSocket.all.length - 1];
  s.open();
  return s;
}
const bubbles = () => document.querySelectorAll('#list > *');

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('static page hygiene', () => {
  const pages = { PAIR_HTML, VIEWER_HTML };
  const all = { PAIR_HTML, VIEWER_HTML, PAIR_JS, VIEWER_JS, APP_CSS };

  it('has no inline script, on* handler or style in the HTML', () => {
    for (const html of Object.values(pages)) {
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/<style|\sstyle\s*=/i);
      expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
      expect(html).toContain('name="referrer" content="no-referrer"');
      expect(html).toContain('name="robots" content="noindex"');
    }
  });

  it('references no third-party http(s) URL anywhere', () => {
    for (const s of Object.values(all)) expect(s).not.toMatch(/https?:\/\//i);
  });

  it('keeps forbidden APIs out of the viewer script', () => {
    for (const bad of [
      '.send(', 'eval(', 'new Function', 'innerHTML', 'outerHTML', 'document.write',
      'localStorage', 'sessionStorage', 'indexedDB', 'caches.', 'serviceWorker', 'navigator.clipboard',
    ]) {
      expect(VIEWER_JS, bad).not.toContain(bad);
    }
  });

  it('has no input element in the viewer HTML', () => {
    expect(VIEWER_HTML).not.toMatch(/<input|<textarea|contenteditable/i);
  });

  it('exposes the pages through REMOTE_ASSETS', () => {
    expect(REMOTE_ASSETS).toEqual({
      pairHtml: PAIR_HTML, pairJs: PAIR_JS, viewerHtml: VIEWER_HTML, viewerJs: VIEWER_JS, appCss: APP_CSS,
    });
  });
});

describe('contentSecurityPolicy', () => {
  it('is strict and names the bound host in connect-src', () => {
    const csp = contentSecurityPolicy('100.64.1.2:47821');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("connect-src 'self' ws://100.64.1.2:47821;");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe('pair page', () => {
  it('strips the fragment before the first fetch and posts the code in a JSON body', async () => {
    expect(PAIR_JS.indexOf('replaceState')).toBeGreaterThan(-1);
    expect(PAIR_JS.indexOf('replaceState')).toBeLessThan(PAIR_JS.indexOf('fetch('));
    window.history.replaceState(null, '', '/pair#c=ABCD-1234');
    document.body.innerHTML = bodyOf(PAIR_HTML);
    const seen: { hash: string; url: string; init: RequestInit }[] = [];
    (window as unknown as { fetch: unknown }).fetch = (url: string, init: RequestInit) => {
      seen.push({ hash: location.hash, url, init });
      return Promise.resolve({ status: 401 });
    };
    window.eval(PAIR_JS);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].hash).toBe('');
    expect(seen[0].url).toBe('/api/pair');
    expect(seen[0].init.method).toBe('POST');
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ code: 'ABCD-1234' });
    expect(document.getElementById('msg')!.textContent).toBe('Code not accepted or expired.');
  });

  it('shows the rate-limit message on 429', async () => {
    window.history.replaceState(null, '', '/pair');
    document.body.innerHTML = bodyOf(PAIR_HTML);
    (window as unknown as { fetch: unknown }).fetch = () => Promise.resolve({ status: 429 });
    window.eval(PAIR_JS);
    (document.getElementById('code') as HTMLInputElement).value = 'zzzz-0000';
    (document.getElementById('go') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('msg')!.textContent).toBe(
      'Too many attempts. Create a new code on the desktop.',
    );
  });
});

describe('viewer behaviour', () => {
  it('connects to /ws on the page host and renders session, history and events', () => {
    const s = startViewer();
    expect(s.url).toMatch(/^ws:\/\/[^/]+\/ws$/);
    s.push({ t: 'session', attached: true, title: 'My chat' });
    expect(document.getElementById('title')!.textContent).toBe('My chat');
    s.push({ t: 'history', events: [msg('0:0', 'hello', { role: 'you' }), msg('9:1', 'hi', { tools: ['Read'] })] });
    expect(bubbles()).toHaveLength(2);
    expect(bubbles()[0].classList.contains('you')).toBe(true);
    expect(bubbles()[1].textContent).toContain('hi');
    expect(bubbles()[1].querySelector('.chip')!.textContent).toBe('Read');
    s.push({ t: 'event', event: msg('20:2', 'more', { truncated: true }) });
    expect(bubbles()).toHaveLength(3);
    expect(bubbles()[2].textContent).toContain('(truncated)');
  });

  it('renders traffic cards with route, subject, status and tap-to-expand', () => {
    const s = startViewer();
    s.push({
      t: 'history',
      events: [{ k: 'traffic', id: 't:1', atMs: 1, kind: 'handback', from: 'builder', to: 'main', subject: 'T7', text: 'done', truncated: false, status: 'completed' }],
    });
    const card = bubbles()[0];
    expect(card.textContent).toContain('builder -> main');
    expect(card.textContent).toContain('T7');
    expect(card.querySelector('.badge')!.textContent).toBe('completed');
    const body = card.querySelector('.clamp')!;
    body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(body.classList.contains('expanded')).toBe(true);
  });

  it('renders markup in message text as literal text', () => {
    const s = startViewer();
    const evil = '<img src=x onerror=alert(1)>';
    s.push({ t: 'history', events: [msg('1:1', evil)] });
    expect(document.querySelector('#list img')).toBeNull();
    expect(bubbles()[0].querySelector('.text')!.textContent).toBe(evil);
  });

  it('ignores a duplicate id', () => {
    const s = startViewer();
    s.push({ t: 'history', events: [msg('1:1', 'a')] });
    s.push({ t: 'event', event: msg('1:1', 'a') });
    expect(bubbles()).toHaveLength(1);
  });

  it('keeps at most 200 bubbles, dropping the oldest, and forgets pruned ids', () => {
    const s = startViewer();
    const events = Array.from({ length: 250 }, (_, i) => msg(`${i}:0`, `m${i}`));
    s.push({ t: 'history', events });
    expect(bubbles()).toHaveLength(200);
    expect(bubbles()[0].textContent).toContain('m50');
    s.push({ t: 'event', event: msg('0:0', 'again') });
    expect(bubbles()).toHaveLength(200);
    expect(bubbles()[199].textContent).toContain('again');
  });

  it('history replaces the list and an unattached session does not clear it', () => {
    const s = startViewer();
    s.push({ t: 'history', events: [msg('1:1', 'a'), msg('2:1', 'b')] });
    s.push({ t: 'session', attached: false, title: null });
    expect(bubbles()).toHaveLength(2);
    expect(document.getElementById('banner')!.textContent).toBe('No Claude session is pinned in Aether.');
    expect(document.getElementById('banner')!.hidden).toBe(false);
    s.push({ t: 'history', events: [msg('3:1', 'c')] });
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].textContent).toContain('c');
  });

  it('never sends anything on the socket', () => {
    const s = startViewer();
    s.push({ t: 'session', attached: true, title: 't' });
    s.push({ t: 'history', events: [msg('1:1', 'a')] });
    s.push({ t: 'event', event: msg('2:1', 'b') });
    document.getElementById('pill')!.click();
    s.drop();
    vi.advanceTimersByTime(20_000);
    expect(FakeSocket.all.flatMap((x) => x.sends)).toHaveLength(0);
  });

  it('does not reconnect after bye and shows the reason', () => {
    const s = startViewer();
    s.push({ t: 'bye', reason: 'revoked' });
    s.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(document.getElementById('state')!.textContent).toBe('This phone was unpaired.');
  });

  it('reconnects with backoff after an unexpected close', () => {
    const s = startViewer();
    s.drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('stops retrying with a pair-again message when the socket stops opening after a success', () => {
    const s = startViewer();
    s.drop();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[1].drop();
    vi.advanceTimersByTime(2000);
    FakeSocket.all[2].drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(3);
    expect(document.getElementById('state')!.textContent).toBe('Paired session ended. Pair again.');
  });
});
