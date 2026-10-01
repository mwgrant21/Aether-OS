// Issue #104: with the setting off (the default) the collector must never reach
// the claude -p extractor. child_process is mocked at the module boundary and
// startCollector runs for real with NO injected exec, so this proves the default
// exec is unreachable rather than that an injected one was not called.
//
// The positive control (setting on -> exactly one `-p` exec observed) is what keeps
// the off-cases from passing vacuously: if the mock, fixture, or timing stopped
// producing an exec at all, the control fails.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// Runtime require, not a static import: Vite strips the node: prefix off node:sqlite.
const nodeRequire = createRequire(import.meta.url);
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import { startCollector, memoryExtractionTick } from './index.js';
import { createMemoryStore } from './memoryStore.js';
import { createMemoryExtractQueue } from './memoryExtractQueue.js';

function agentToolUseLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'CINDER' } }],
    },
  });
}

function taskNotificationLine(toolUseId: string, timestamp: string): string {
  const content =
    '<task-notification>\n' +
    `<tool-use-id>${toolUseId}</tool-use-id>\n` +
    '<result>User overruled a suggestion to add a retry loop, accepting unbounded retry instead.</result>\n' +
    '<subagent_tokens>500</subagent_tokens>\n' +
    '<tool_uses>8</tool_uses>\n' +
    '<duration_ms>90000</duration_ms>\n' +
    '</task-notification>';
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp,
    origin: { kind: 'task-notification' },
    message: { content },
  });
}

type ExecCall = { file: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } | undefined };

function claudePromptCalls(): ExecCall[] {
  return (execFileMock.mock.calls as unknown[][])
    .map((c) => ({
      file: c[0] as string,
      args: (Array.isArray(c[1]) ? c[1] : []) as string[],
      opts: (typeof c[2] === 'object' && c[2] !== null ? c[2] : undefined) as ExecCall['opts'],
    }))
    .filter((c) => c.file === 'claude' && c.args.includes('-p'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('memory extraction gate (#104)', () => {
  let dir: string;
  let settingsPath: string;
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    execFileMock.mockReset();
    // No promisify.custom: promisify resolves with the object handed to the callback.
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '[]', stderr: '' });
    });
    dir = mkdtempSync(join(tmpdir(), 'aether-gate-'));
    settingsPath = join(dir, 'collector-settings.json');
    const proj = join(dir, 'projects', 'my-project');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'session.jsonl'),
      [agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'), taskNotificationLine('tu_1', '2026-07-08T09:01:30Z')].join('\n') + '\n',
      'utf8'
    );
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak';
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  });

  function start(): () => void {
    return startCollector({
      dbPath: join(dir, 'collector.db'),
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000,
      compactIntervalMs: 1_000_000,
      projectsRoot: join(dir, 'projects'),
      transcriptScanIntervalMs: 50,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 50,
      collectorSettingsPath: settingsPath,
    });
  }

  it('POSITIVE CONTROL: setting on -> exactly one claude -p exec, with API-key env scrubbed', async () => {
    writeFileSync(settingsPath, '{"memoryExtractionEnabled":true}', 'utf8');
    const stop = start();
    await sleep(300);
    stop();
    const calls = claudePromptCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.env).toBeDefined();
    expect(calls[0].opts?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].opts?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(calls[0].opts?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
    // The scrub copies; it must not mutate the collector's own environment.
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-should-not-leak');
  });

  it('setting file absent (the default) -> no claude -p exec', async () => {
    const stop = start();
    await sleep(300);
    stop();
    expect(claudePromptCalls()).toEqual([]);
  });

  it('setting explicitly false -> no claude -p exec', async () => {
    writeFileSync(settingsPath, '{"memoryExtractionEnabled":false}', 'utf8');
    const stop = start();
    await sleep(300);
    stop();
    expect(claudePromptCalls()).toEqual([]);
  });

  // Start with an EMPTY projects dir so the initial scan/drain cannot mask anything:
  // the transcript appears only after start, is scanned by the 50 ms scan timer while
  // the setting is off, and the setting flips on before the 400 ms drain fires.
  function startSlowDrain(): () => void {
    return startCollector({
      dbPath: join(dir, 'collector.db'),
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000,
      compactIntervalMs: 1_000_000,
      projectsRoot: join(dir, 'projects'),
      transcriptScanIntervalMs: 50,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 400,
      collectorSettingsPath: settingsPath,
    });
  }

  function writeFixture(): void {
    const proj = join(dir, 'projects', 'my-project');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'session.jsonl'),
      [agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'), taskNotificationLine('tu_1', '2026-07-08T09:01:30Z')].join('\n') + '\n',
      'utf8'
    );
  }

  // Bounded wait until the scan timer has actually consumed the fixture
  // (transcript_files.last_offset > 0). Without it, a flip after a fixed sleep can
  // land before any scan and the "never sent" assertions pass vacuously.
  async function waitUntilScanned(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let scanned = false;
      let db: DatabaseSync | undefined;
      try {
        db = new (nodeRequire('node:sqlite').DatabaseSync)(join(dir, 'collector.db'), { readOnly: true }) as DatabaseSync;
        const row = db.prepare('SELECT COUNT(*) AS n FROM transcript_files WHERE last_offset > 0').get() as { n: number };
        scanned = row.n > 0;
      } catch {
        // db or table not there yet
      } finally {
        db?.close();
      }
      if (scanned) return;
      await sleep(20);
    }
    throw new Error('fixture was never scanned within ' + timeoutMs + ' ms');
  }

  it('work scanned while off is never staged: enabling before the next drain does not send it', async () => {
    rmSync(join(dir, 'projects'), { recursive: true, force: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    const stop = startSlowDrain();
    writeFixture();
    await waitUntilScanned(); // scans run while off
    writeFileSync(settingsPath, '{"memoryExtractionEnabled":true}', 'utf8');
    await sleep(600); // past the 400 ms drain
    stop();
    expect(claudePromptCalls()).toEqual([]);
  });

  it('item staged while on but turned off before the drain is never sent', async () => {
    rmSync(join(dir, 'projects'), { recursive: true, force: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    writeFileSync(settingsPath, '{"memoryExtractionEnabled":true}', 'utf8');
    const stop = startSlowDrain();
    writeFixture();
    await waitUntilScanned(); // staged while on
    writeFileSync(settingsPath, '{"memoryExtractionEnabled":false}', 'utf8');
    await sleep(600);
    stop();
    expect(claudePromptCalls()).toEqual([]);
  });
});

describe('memoryExtractionTick', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aether-tick-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function queueWithOneItem() {
    const queue = createMemoryExtractQueue();
    queue.push({
      agentId: 'CINDER',
      taskKind: 'dispatch',
      sessionId: 's1',
      toolUseId: 'tu_1',
      runSummary: 'User overruled a suggestion.',
      queuedAtMs: 0,
    });
    return queue;
  }

  it('disabled: discards the queue without calling the extractor', async () => {
    const store = createMemoryStore(join(dir, 'memory.db'));
    const queue = queueWithOneItem();
    expect(queue.size()).toBe(1);
    const execFn = vi.fn(async () => ({ stdout: '[]' }));
    await memoryExtractionTick(store, queue, join(dir, 'missing.json'), execFn);
    expect(execFn).not.toHaveBeenCalled();
    expect(queue.size()).toBe(0);
    store.close();
  });

  it('turning the setting off mid-batch stops the remaining items', async () => {
    const store = createMemoryStore(join(dir, 'memory.db'));
    const settings = join(dir, 'collector-settings.json');
    writeFileSync(settings, '{"memoryExtractionEnabled":true}', 'utf8');
    const queue = queueWithOneItem();
    queue.push({
      agentId: 'CINDER',
      taskKind: 'dispatch',
      sessionId: 's1',
      toolUseId: 'tu_2',
      runSummary: 'Second item.',
      queuedAtMs: 0,
    });
    const execFn = vi.fn(async () => {
      writeFileSync(settings, '{"memoryExtractionEnabled":false}', 'utf8');
      return { stdout: '[]' };
    });
    await memoryExtractionTick(store, queue, settings, execFn);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    store.close();
  });

  it('enabled: drains through the extractor', async () => {
    const store = createMemoryStore(join(dir, 'memory.db'));
    const settings = join(dir, 'collector-settings.json');
    writeFileSync(settings, '{"memoryExtractionEnabled":true}', 'utf8');
    const queue = queueWithOneItem();
    const execFn = vi.fn(async () => ({ stdout: '[]' }));
    await memoryExtractionTick(store, queue, settings, execFn);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    store.close();
  });
});
