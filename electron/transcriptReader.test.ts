import { describe, it, expect } from 'vitest';
import path from 'path';
import { readTranscript, listTranscriptSources, resolveSourcePath } from './transcriptReader';

const FIXTURE = path.join(__dirname, '__fixtures__', 'transcript-sample.jsonl');
const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

describe('readTranscript', () => {
  it('parses the fixture into display messages, skipping the malformed line and the fully-correlated tool-result carrier', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });

    // 5 lines in the fixture, 1 malformed. u3 is a pure tool_result carrier
    // whose one result (tool-1) gets correlated onto u2's Bash call, so u3
    // is dropped rather than rendering as a redundant blank row -- see the
    // post-hoc fix (final review, findings 1/2) in readTranscript's
    // correlation pass. 4 raw messages -> 3 display messages.
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'u2', 'u4']);
  });

  it('does not throw on the malformed line', async () => {
    await expect(readTranscript(FIXTURE, { limit: 50 })).resolves.toBeDefined();
  });

  it('surfaces a human prompt', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });
    const human = messages.find((m) => m.id === 'u1')!;
    expect(human.role).toBe('human');
    expect(human.text).toBe('Please run the test suite and fix any failures.');
  });

  it('surfaces assistant text and both tool_use blocks with labels, with the Bash call correlated to its later tool_result', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });
    const assistant = messages.find((m) => m.id === 'u2')!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.text).toBe("I'll run the tests and check the failing file.");
    expect(assistant.toolCalls).toEqual([
      { name: 'Bash', label: 'npm test', toolUseId: 'tool-1', resultLength: expect.any(Number) },
      { name: 'Read', label: 'index.ts', toolUseId: 'tool-2', resultLength: null },
    ]);
  });

  it('correlates a tool_result onto its tool_use as resultLength only, never content, and drops the now-redundant carrier line', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });
    // u3 was the pure tool_result carrier for tool-1 -- fully consumed by
    // correlation, so it's gone from the returned list (see readTranscript's
    // correlation pass).
    expect(messages.find((m) => m.id === 'u3')).toBeUndefined();
    const assistant = messages.find((m) => m.id === 'u2')!;
    expect(assistant.toolCalls[0].resultLength).toEqual(expect.any(Number));
    expect(JSON.stringify(messages)).not.toContain('passing');
  });

  it('includes a task-notification completion line', async () => {
    const { messages } = await readTranscript(FIXTURE, { limit: 50 });
    expect(messages.find((m) => m.id === 'u4')).toBeDefined();
  });

  it('respects a small limit by counting raw lines, not just valid messages', async () => {
    // limit is a line budget (per the spec: "until `limit` complete lines are
    // collected"), not a valid-message budget -- the fixture's trailing
    // malformed line is the most recent line on disk, so a limit of 2 reads
    // that line plus u4, and only u4 survives parseTranscriptLine.
    const { messages } = await readTranscript(FIXTURE, { limit: 2 });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('u4');

    // A limit of 3 reaches back far enough to also pick up u3.
    const wider = await readTranscript(FIXTURE, { limit: 3 });
    expect(wider.messages.map((m) => m.id)).toEqual(['u3', 'u4']);
  });

  it('returns a nextBefore that pages further back, and null once file start is reached', async () => {
    const firstPage = await readTranscript(FIXTURE, { limit: 2 });
    expect(firstPage.nextBefore).not.toBeNull();

    const secondPage = await readTranscript(FIXTURE, { limit: 50, before: firstPage.nextBefore! });
    // Paging back from the tail-most 2 lines should reach every earlier line,
    // and nothing in the second page should overlap the first (strictly
    // older, since `before` is exclusive of the line it points at). u3's
    // result correlates onto u2's Bash call within this page's own window,
    // so u3 itself is dropped -- see readTranscript's correlation pass.
    expect(secondPage.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
    expect(secondPage.nextBefore).toBeNull();
  });

  it('pages older messages via before end-to-end (full walk reconstructs the whole file)', async () => {
    // before: 0 means "nothing before the start of the file" -> empty page.
    const nothingOlder = await readTranscript(FIXTURE, { limit: 50, before: '0' });
    expect(nothingOlder.messages).toEqual([]);
    expect(nothingOlder.nextBefore).toBeNull();

    // A before at the end of the file behaves the same as no before at all.
    const fileSize = (await (await import('fs')).promises.stat(FIXTURE)).size;
    const everything = await readTranscript(FIXTURE, { limit: 50, before: String(fileSize) });
    const noBefore = await readTranscript(FIXTURE, { limit: 50 });
    expect(everything).toEqual(noBefore);

    // Walking backward one line at a time via nextBefore must reconstruct
    // every message in the file, oldest to newest, with no gaps or repeats.
    const collected: string[] = [];
    let before: string | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      const page = await readTranscript(FIXTURE, { limit: 1, before });
      collected.unshift(...page.messages.map((m) => m.id));
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }
    expect(collected).toEqual(['u1', 'u2', 'u3', 'u4']);
  });
});

describe('listTranscriptSources', () => {
  it('returns [] when there is no pinned session', async () => {
    const sources = await listTranscriptSources('/nonexistent', null);
    expect(sources).toEqual([]);
  });

  it('returns just the session source when no subagents dir exists', async () => {
    const sources = await listTranscriptSources(FIXTURES_DIR, 'transcript-sample');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: 'transcript-sample', kind: 'session', label: 'Session' });
  });

  it('enumerates multiple dispatch sources: meta-label resolution, meta-missing fallback, and malformed meta fallback', async () => {
    const sources = await listTranscriptSources(FIXTURES_DIR, 'sess-multi');

    expect(sources).toHaveLength(4); // 1 session + 3 dispatches
    expect(sources[0]).toMatchObject({ id: 'sess-multi', kind: 'session', label: 'Session' });

    const dispatches = sources.slice(1);
    expect(dispatches.map((d) => d.id).sort()).toEqual(
      ['dispatch:sess-multi:agent-aaa', 'dispatch:sess-multi:agent-bbb', 'dispatch:sess-multi:agent-ccc'].sort()
    );
    expect(dispatches.every((d) => d.kind === 'dispatch')).toBe(true);

    // agent-aaa has a valid meta.json -> label resolves from `description`.
    const aaa = dispatches.find((d) => d.id === 'dispatch:sess-multi:agent-aaa')!;
    expect(aaa.label).toBe('Fix widget bug');

    // agent-bbb has no meta.json -> label falls back to the file's own basename.
    const bbb = dispatches.find((d) => d.id === 'dispatch:sess-multi:agent-bbb')!;
    expect(bbb.label).toBe('agent-bbb');

    // agent-ccc has a malformed meta.json -> same fallback, no throw.
    const ccc = dispatches.find((d) => d.id === 'dispatch:sess-multi:agent-ccc')!;
    expect(ccc.label).toBe('agent-ccc');
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

  it('rejects a session id containing a parent-directory traversal', () => {
    expect(() => resolveSourcePath('/root', '../../etc/passwd')).toThrow();
  });

  it('rejects a session id containing a path separator', () => {
    expect(() => resolveSourcePath('/root', 'sub/dir')).toThrow();
    expect(() => resolveSourcePath('/root', 'sub\\dir')).toThrow();
  });

  it('rejects a dispatch id whose parentId or agentBase attempts traversal', () => {
    expect(() => resolveSourcePath('/root', 'dispatch:..:agent-abc')).toThrow();
    expect(() => resolveSourcePath('/root', 'dispatch:sess-1:../../secret')).toThrow();
  });

  it('rejects a malformed dispatch id (wrong number of segments)', () => {
    expect(() => resolveSourcePath('/root', 'dispatch:onlyone')).toThrow();
  });
});
