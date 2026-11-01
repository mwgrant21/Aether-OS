// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionBook, summarizePermission } from './voicePermissions';

const KEY = 'sk-ant-' + 'Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7xC0';

describe('summarizePermission', () => {
  it('masks a sk-ant key inside a Bash command', () => {
    const s = summarizePermission('Bash', { command: `curl -H "x: ${KEY}" https://x` });
    expect(s).not.toContain(KEY);
    expect(s.startsWith('Bash: ')).toBe(true);
  });

  it('shows only the basename of a path, never an absolute path', () => {
    const s = summarizePermission('Write', { file_path: 'C:\\Users\\Matt\\secret\\notes.txt' });
    expect(s).toBe('Write: notes.txt');
    expect(summarizePermission('Read', { path: '/home/x/y/z.md' })).toBe('Read: z.md');
  });

  it('collapses newlines, caps the hint at 80 and the line at 160, empty hint otherwise', () => {
    const s = summarizePermission('Bash', { command: 'a\nb\n' + 'x'.repeat(200) });
    expect(s).not.toMatch(/[\r\n]/);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.length).toBeLessThanOrEqual('Bash: '.length + 80);
    expect(summarizePermission('Weird', { other: 1 })).toBe('Weird:');
    expect(summarizePermission('T', null)).toBe('T:');
  });
});

describe('permission book', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answer is single-use and unknown ids are false', () => {
    const onTimeout = vi.fn();
    const book = createPermissionBook({ timeoutMs: 1000, onTimeout });
    book.open('a');
    expect(book.answer('a')).toBe(true);
    expect(book.answer('a')).toBe(false);
    expect(book.answer('nope')).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('an unanswered id times out once and is then closed', () => {
    const onTimeout = vi.fn();
    const book = createPermissionBook({ timeoutMs: 1000, onTimeout });
    book.open('a');
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledWith('a');
    expect(book.answer('a')).toBe(false);
  });

  it('closeAll forgets ids without timing out', () => {
    const onTimeout = vi.fn();
    const book = createPermissionBook({ timeoutMs: 1000, onTimeout });
    book.open('a');
    book.open('b');
    book.closeAll();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(book.answer('a')).toBe(false);
    expect(book.size()).toBe(0);
  });
});
