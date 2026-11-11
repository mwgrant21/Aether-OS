import { describe, it, expect, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { scanAllProjects } from './historyScanner';
import { computeWeeklyTokens } from '../src/components/dashboard/realUsageMath';

function assistantLine(sessionId: string, outputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-08-01T12:00:00.000Z',
    message: {
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 10, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [],
    },
  });
}

const tmpDirs: string[] = [];

async function makeTmpProjectsRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'historyScanner-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('scanAllProjects', () => {
  it('returns events from a top-level session file with no subagents dir', async () => {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), assistantLine('session-1', 100) + '\n');

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(1);
    expect(events[0].usage?.outputTokens).toBe(100);
  });

  // The reproduction of the P1 finding: a dispatch's own tool calls and
  // token usage live in a separate file nested under
  // <sessionId>/subagents/, never inside the flat top-level directory
  // listing. Both the parent session file's events AND the subagent file's
  // events must come back from a single scanAllProjects call.
  it('also scans <sessionId>/subagents/*.jsonl and merges those events into the same stream', async () => {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    const subagentsDir = path.join(projectDir, 'session-1', 'subagents');
    await fsp.mkdir(subagentsDir, { recursive: true });

    await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), assistantLine('session-1', 100) + '\n');
    await fsp.writeFile(
      path.join(subagentsDir, 'agent-x.jsonl'),
      assistantLine('session-1', 5000) + '\n',
    );

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    const outputTokens = events.map((e) => e.usage?.outputTokens).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(outputTokens).toEqual([100, 5000]);
  });

  it('ignores non-.jsonl files inside a subagents directory', async () => {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    const subagentsDir = path.join(projectDir, 'session-1', 'subagents');
    await fsp.mkdir(subagentsDir, { recursive: true });

    await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), assistantLine('session-1', 100) + '\n');
    await fsp.writeFile(path.join(subagentsDir, 'agent-x.jsonl'), assistantLine('session-1', 5000) + '\n');
    await fsp.writeFile(path.join(subagentsDir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
  });

  // Finding: the subagents-dir readdir caught ALL errors, not just ENOENT
  // (no subagents dir -- the expected, common case). A non-ENOENT error
  // (EACCES, transient I/O) must not be silently swallowed, or this
  // recreates the exact undercount bug the subagent-scan fix above exists
  // to prevent -- just via a different, non-obvious failure path.
  it('still silently skips a session with no subagents dir (ENOENT)', async () => {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), assistantLine('session-1', 100) + '\n');

    // No <projectDir>/session-1/subagents directory created at all.
    await expect(scanAllProjects(root)).resolves.toHaveLength(1);
  });

  it('does not swallow a non-ENOENT error reading a subagents dir', async () => {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    const sessionDir = path.join(projectDir, 'session-1');
    await fsp.mkdir(sessionDir, { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'session-1.jsonl'), assistantLine('session-1', 100) + '\n');

    // Create "subagents" as a FILE, not a directory, so fsp.readdir on it
    // fails with ENOTDIR rather than ENOENT -- a stand-in for any real
    // non-ENOENT failure (e.g. EACCES) that must propagate, not vanish.
    await fsp.writeFile(path.join(sessionDir, 'subagents'), 'not a directory');

    await expect(scanAllProjects(root)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

// Claude Code streams one API message as several transcript lines that repeat
// the same usage. Each key (message.id + requestId) must count once, but every
// line stays in the stream because each carries a different content block.
function streamedLine(opts: {
  outputTokens: number;
  messageId?: string;
  requestId?: string;
  toolUse?: boolean;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    timestamp: '2026-08-01T12:00:00.000Z',
    requestId: opts.requestId,
    message: {
      id: opts.messageId,
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 10, output_tokens: opts.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: opts.toolUse ? [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] : [],
    },
  });
}

describe('scanAllProjects streamed-message dedupe', () => {
  async function projectWith(files: Record<string, string[]>): Promise<string> {
    const root = await makeTmpProjectsRoot();
    const projectDir = path.join(root, 'my-project');
    for (const [rel, lines] of Object.entries(files)) {
      const target = path.join(projectDir, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, lines.join('\n') + '\n');
    }
    return root;
  }

  it('counts usage once for repeated lines with the same message.id and requestId', async () => {
    const line = streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1' });
    const root = await projectWith({ 'session-1.jsonl': [line, line, line] });

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.usage !== null)).toHaveLength(1);
    expect(events.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0)).toBe(100);
  });

  it('counts a key once across a top-level file and a subagents file', async () => {
    const line = streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1' });
    const root = await projectWith({
      'session-1.jsonl': [line],
      'session-1/subagents/agent-x.jsonl': [line],
    });

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0)).toBe(100);
  });

  it('keeps toolUses on a repeat line whose usage is nulled', async () => {
    const root = await projectWith({
      'session-1.jsonl': [
        streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1' }),
        streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1', toolUse: true }),
      ],
    });

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events[1].usage).toBeNull();
    expect(events[1].toolUses).toHaveLength(1);
  });

  it('does not dedupe a different requestId or lines with no message.id', async () => {
    const root = await projectWith({
      'session-1.jsonl': [
        streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1' }),
        streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_2' }),
        streamedLine({ outputTokens: 100 }),
        streamedLine({ outputTokens: 100 }),
      ],
    });

    const events = await scanAllProjects(root);
    expect(events.filter((e) => e.usage !== null)).toHaveLength(4);
  });

  it('does not let a usage-less line reserve the key of a later line with usage', async () => {
    const noUsage = JSON.stringify({
      type: 'assistant',
      sessionId: 'session-1',
      timestamp: '2026-08-01T12:00:00.000Z',
      requestId: 'req_1',
      message: { id: 'msg_1', model: 'claude-sonnet-4-5', content: [] },
    });
    const withUsage = JSON.stringify({
      type: 'assistant',
      sessionId: 'session-1',
      timestamp: '2026-08-01T12:00:00.000Z',
      requestId: 'req_1',
      message: {
        id: 'msg_1',
        model: 'claude-sonnet-4-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [],
      },
    });
    const root = await projectWith({ 'session-1.jsonl': [noUsage, withUsage] });

    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0)).toBe(100);
    expect(events.reduce((sum, e) => sum + (e.usage?.outputTokens ?? 0), 0)).toBe(50);
  });

  const keyedLine = (usage: unknown, toolUse = false) => JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    timestamp: '2026-08-01T12:00:00.000Z',
    requestId: 'req_1',
    message: {
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      ...(usage === undefined ? {} : { usage }),
      content: toolUse ? [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] : [],
    },
  });
  const full = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  it('counts a usage line once when a usage-less line of the same message follows it', async () => {
    const root = await projectWith({ 'session-1.jsonl': [keyedLine(full), keyedLine(undefined)] });
    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0)).toBe(100);
  });

  it('counts the later usage line when the earlier usage-less line carries a tool_use', async () => {
    const root = await projectWith({ 'session-1.jsonl': [keyedLine(undefined, true), keyedLine(full)] });
    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events[0].toolUses).toHaveLength(1);
    expect(events.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0)).toBe(100);
  });

  it('lets an empty usage object reserve its key, so a later full usage line is not double counted', async () => {
    const root = await projectWith({ 'session-1.jsonl': [keyedLine({}), keyedLine(full)] });
    const events = await scanAllProjects(root);
    expect(events).toHaveLength(2);
    expect(events[1].usage).toBeNull();
    expect(events.reduce((sum, e) => sum + (e.usage?.inputTokens ?? 0), 0)).toBe(0);
  });

  it('feeds computeWeeklyTokens the single-count value', async () => {
    const line = streamedLine({ outputTokens: 100, messageId: 'msg_1', requestId: 'req_1' });
    const root = await projectWith({ 'session-1.jsonl': [line, line, line] });

    const events = await scanAllProjects(root);
    const buckets = computeWeeklyTokens(events, new Date('2026-08-01T13:00:00.000Z'));
    // input 10 + output 100, once (previously 330).
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(110);
  });
});
