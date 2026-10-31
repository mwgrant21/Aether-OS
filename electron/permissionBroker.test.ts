import { describe, expect, it } from 'vitest';
import { createPermissionBroker, summarizePermission } from './permissionBroker';
import type { PromptInfo } from '../src/shared/remote/types';

function harness(timeoutMs = 120000) {
  let t = 1000;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const broker = createPermissionBroker({
    now: () => t,
    timeoutMs,
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { (h as { cleared: boolean }).cleared = true; },
  });
  return { broker, timers, advance: (ms: number) => { t += ms; } };
}
function recorder() {
  const log: string[] = [];
  const opened: PromptInfo[] = [];
  return {
    log,
    opened,
    tap: {
      opened: (p: PromptInfo) => { opened.push(p); log.push('o:' + p.id); },
      closed: (e: { id: string; reason: string }) => { log.push(`c:${e.id}:${e.reason}`); },
    },
  };
}
const bash = { id: 'a', toolName: 'Bash', toolInput: { command: 'ls' }, risk: 'MED' as const };

describe('summarizePermission', () => {
  it('uses command, file path, or tool name plus keys, capped at 1200', () => {
    expect(summarizePermission('Bash', { command: './gradlew test' })).toBe('./gradlew test');
    expect(summarizePermission('Edit', { file_path: 'C:/a/b.ts', old_string: 'x' })).toBe('C:/a/b.ts');
    expect(summarizePermission('WebFetch', { url: 'u', prompt: 'p' })).toBe('WebFetch (url, prompt)');
    expect(summarizePermission('Weird', null)).toBe('Weird');
    expect(summarizePermission('Bash', { command: 'x'.repeat(5000) })).toHaveLength(1200);
  });
});

describe('permissionBroker', () => {
  it('replays pending prompts to a late tap with the remaining ttl', () => {
    const { broker, advance } = harness(120000);
    broker.open(bash);
    advance(18000);
    const r = recorder();
    broker.readPort().attach(r.tap);
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0].ttlMs).toBe(102000);
  });

  it('forwards live opened/closed and close is idempotent', () => {
    const { broker } = harness();
    const r = recorder();
    broker.readPort().attach(r.tap);
    broker.open(bash);
    expect(broker.close('a', 'answered-desktop')).toBe(true);
    expect(broker.close('a', 'answered-desktop')).toBe(false);
    expect(broker.close('nope', 'timeout')).toBe(false);
    expect(r.log).toEqual(['o:a', 'c:a:answered-desktop']);
  });

  it('timeout closes once and a later attach does not resurrect it', () => {
    const { broker, timers } = harness();
    const r = recorder();
    broker.readPort().attach(r.tap);
    broker.open(bash);
    expect(timers[0].ms).toBe(120000);
    timers[0].fn();
    timers[0].fn();
    expect(r.log).toEqual(['o:a', 'c:a:timeout']);
    const late = recorder();
    broker.readPort().attach(late.tap);
    expect(late.log).toEqual([]);
  });

  it('answering clears the timer and retains nothing', () => {
    const { broker, timers } = harness();
    broker.open(bash);
    broker.close('a', 'answered-desktop');
    expect(timers[0].cleared).toBe(true);
    const late = recorder();
    broker.readPort().attach(late.tap);
    expect(late.log).toEqual([]);
  });

  it('a throwing tap does not break other taps, open, or close', () => {
    const { broker } = harness();
    const bad = { opened: () => { throw new Error('x'); }, closed: () => { throw new Error('y'); } };
    const r = recorder();
    broker.readPort().attach(bad);
    broker.readPort().attach(r.tap);
    expect(() => broker.open(bash)).not.toThrow();
    expect(() => broker.close('a', 'answered-desktop')).not.toThrow();
    expect(r.log).toEqual(['o:a', 'c:a:answered-desktop']);
  });

  it('detach stops delivery and is idempotent', () => {
    const { broker } = harness();
    const r = recorder();
    const h = broker.readPort().attach(r.tap);
    h.detach();
    h.detach();
    broker.open(bash);
    expect(r.log).toEqual([]);
  });
});
