import { describe, it, expect, afterEach } from 'vitest';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { scanAllProjects } from './historyScanner';

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
});
