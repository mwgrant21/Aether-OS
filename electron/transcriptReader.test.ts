import { describe, it, expect } from 'vitest';
import path from 'path';
import { readTranscript, listTranscriptSources, resolveSourcePath } from './transcriptReader';

const FIXTURE = path.join(__dirname, '__fixtures__', 'transcript-sample.jsonl');

describe('readTranscript', () => {
  it('parses the fixture into display messages, skipping the malformed line', async () => {
    const messages = await readTranscript(FIXTURE, { limit: 50 });

    // 5 lines in the fixture, 1 malformed -> 4 display messages.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('does not throw on the malformed line', async () => {
    await expect(readTranscript(FIXTURE, { limit: 50 })).resolves.toBeDefined();
  });

  it('surfaces a human prompt', async () => {
    const messages = await readTranscript(FIXTURE, { limit: 50 });
    const human = messages.find((m) => m.id === 'u1')!;
    expect(human.role).toBe('human');
    expect(human.text).toBe('Please run the test suite and fix any failures.');
  });

  it('surfaces assistant text and both tool_use blocks with labels', async () => {
    const messages = await readTranscript(FIXTURE, { limit: 50 });
    const assistant = messages.find((m) => m.id === 'u2')!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.text).toBe("I'll run the tests and check the failing file.");
    expect(assistant.toolCalls).toEqual([
      { name: 'Bash', label: 'npm test' },
      { name: 'Read', label: 'index.ts' },
    ]);
  });

  it('surfaces a tool_result as resultLength only, never content', async () => {
    const messages = await readTranscript(FIXTURE, { limit: 50 });
    const result = messages.find((m) => m.id === 'u3')!;
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toEqual({ resultLength: expect.any(Number) });
    expect(JSON.stringify(result)).not.toContain('passing');
  });

  it('includes a task-notification completion line', async () => {
    const messages = await readTranscript(FIXTURE, { limit: 50 });
    expect(messages.find((m) => m.id === 'u4')).toBeDefined();
  });

  it('respects a small limit by counting raw lines, not just valid messages', async () => {
    // limit is a line budget (per the spec: "until `limit` complete lines are
    // collected"), not a valid-message budget -- the fixture's trailing
    // malformed line is the most recent line on disk, so a limit of 2 reads
    // that line plus u4, and only u4 survives parseTranscriptLine.
    const messages = await readTranscript(FIXTURE, { limit: 2 });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('u4');

    // A limit of 3 reaches back far enough to also pick up u3.
    const wider = await readTranscript(FIXTURE, { limit: 3 });
    expect(wider.map((m) => m.id)).toEqual(['u3', 'u4']);
  });

  it('pages older messages via before', async () => {
    // before: 0 means "nothing before the start of the file" -> empty page.
    const nothingOlder = await readTranscript(FIXTURE, { limit: 50, before: '0' });
    expect(nothingOlder).toEqual([]);

    // A before at the end of the file behaves the same as no before at all.
    const fileSize = (await (await import('fs')).promises.stat(FIXTURE)).size;
    const everything = await readTranscript(FIXTURE, { limit: 50, before: String(fileSize) });
    const noBefore = await readTranscript(FIXTURE, { limit: 50 });
    expect(everything).toEqual(noBefore);
  });
});

describe('listTranscriptSources', () => {
  it('returns [] when there is no pinned session', async () => {
    const sources = await listTranscriptSources('/nonexistent', null);
    expect(sources).toEqual([]);
  });

  it('returns just the session source when no subagents dir exists', async () => {
    const sessionDir = path.join(__dirname, '__fixtures__');
    const sources = await listTranscriptSources(sessionDir, 'transcript-sample');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: 'transcript-sample', kind: 'session', label: 'Session' });
  });
});

describe('resolveSourcePath', () => {
  it('resolves a session id directly under sessionDir', () => {
    expect(resolveSourcePath('/root', 'sess-1')).toBe(path.join('/root', 'sess-1.jsonl'));
  });

  it('resolves a dispatch id under <parent>/subagents/', () => {
    expect(resolveSourcePath('/root', 'dispatch:sess-1:agent-abc')).toBe(
      path.join('/root', 'sess-1', 'subagents', 'agent-abc.jsonl')
    );
  });
});
