// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseThreadLine, turnMark } from './threadParser';
import { THREAD_TARGET_CAP, THREAD_TEXT_CAP } from '../src/shared/remote/types';

const TS = '2026-10-28T10:00:00.000Z';
const AT = Date.parse(TS);
const asst = (content: unknown[], extra: object = {}, stop?: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: TS, ...extra, message: { role: 'assistant', stop_reason: stop, content } });
const tool = (name: string, input: unknown): string => asst([{ type: 'tool_use', id: 't', name, input }]);
const user = (content: unknown, extra: object = {}): string =>
  JSON.stringify({ type: 'user', timestamp: TS, ...extra, message: { role: 'user', content } });
const one = (line: string) => parseThreadLine(line, 120);

describe('parseThreadLine event kinds', () => {
  it('human prompt -> user event with id offset:n and epoch-ms at', () => {
    expect(one(user('run the layout checks too'))).toEqual([
      { k: 'user', id: '120:0', at: AT, text: 'run the layout checks too', truncated: false },
    ]);
  });

  it('assistant text -> claude event; blank text emits nothing', () => {
    expect(one(asst([{ type: 'text', text: 'Unit tests pass.' }]))).toEqual([
      { k: 'claude', id: '120:0', at: AT, text: 'Unit tests pass.', truncated: false },
    ]);
    expect(one(asst([{ type: 'text', text: '  \n ' }]))).toEqual([]);
  });

  it('text then one tool event per tool_use, in order, with sequential ids', () => {
    const evs = one(
      asst([
        { type: 'text', text: 'go' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/a.ts' } },
        { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'foo' } },
      ]),
    );
    expect(evs.map((e) => [e.k, e.id])).toEqual([['claude', '120:0'], ['tool', '120:1'], ['tool', '120:2']]);
  });

  it('thinking blocks and tool results are never emitted', () => {
    expect(one(asst([{ type: 'thinking', thinking: 'secret plan' }]))).toEqual([]);
    expect(one(user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]))).toEqual([]);
  });
});

describe('tool target / add / del', () => {
  const t = (name: string, input: unknown) => one(tool(name, input))[0] as Extract<ReturnType<typeof one>[number], { k: 'tool' }>;

  it('file tools use the basename (either separator)', () => {
    expect(t('Read', { file_path: '/repo/src/index.ts' }).target).toBe('index.ts');
    expect(t('Write', { file_path: 'C:\\repo\\KeyRow.kt', content: 'a\nb\nc' })).toMatchObject({ target: 'KeyRow.kt', add: 3, del: null });
    expect(t('NotebookEdit', { notebook_path: '/n/x.ipynb' }).target).toBe('x.ipynb');
  });

  it('Edit counts new/old lines; MultiEdit sums', () => {
    expect(t('Edit', { file_path: '/a/b.kt', old_string: 'a\nb', new_string: 'a\nb\nc\nd' })).toMatchObject({ add: 4, del: 2 });
    expect(
      t('MultiEdit', { file_path: '/a/b.kt', edits: [{ old_string: 'x', new_string: 'y\nz' }, { old_string: 'p\nq', new_string: 'r' }] }),
    ).toMatchObject({ add: 3, del: 3 });
  });

  it('Bash first line, Grep/Glob pattern, WebFetch url, Agent/Task description, others null', () => {
    expect(t('Bash', { command: './gradlew test\n# more' }).target).toBe('./gradlew test');
    expect(t('Grep', { pattern: 'foo.*bar' }).target).toBe('foo.*bar');
    expect(t('Glob', { pattern: '**/*.kt' }).target).toBe('**/*.kt');
    expect(t('WebFetch', { url: 'https://x.test/a' }).target).toBe('https://x.test/a');
    expect(t('Agent', { description: 'scan repo' }).target).toBe('scan repo');
    expect(t('Task', { description: 'scan repo' }).target).toBe('scan repo');
    expect(t('TodoWrite', { todos: [] })).toMatchObject({ target: null, add: null, del: null });
    expect(t('Bash', { command: 'ls' })).toMatchObject({ add: null, del: null });
  });

  it('missing input fields give null, not a throw', () => {
    expect(t('Edit', {})).toMatchObject({ target: null, add: 0, del: 0 });
    expect(one(tool('Read', null))[0]).toMatchObject({ target: null });
  });

  it('target is capped', () => {
    expect(t('Bash', { command: 'x'.repeat(500) }).target).toHaveLength(THREAD_TARGET_CAP);
  });
});

describe('filtering', () => {
  it('drops sidechain lines', () => {
    expect(one(asst([{ type: 'text', text: 'hi' }], { isSidechain: true }))).toEqual([]);
    expect(one(user('hi', { isSidechain: true }))).toEqual([]);
  });

  it('drops meta, compact-summary, system-reminder, task-notification and interrupt prompts', () => {
    expect(one(user('hi', { isMeta: true }))).toEqual([]);
    expect(one(user('summary', { isCompactSummary: true }))).toEqual([]);
    expect(one(user('<system-reminder>x</system-reminder>'))).toEqual([]);
    expect(one(user('done', { origin: { kind: 'task-notification' } }))).toEqual([]);
    expect(one(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toEqual([]);
  });

  it('ignores bad JSON and non-message line types', () => {
    expect(one('not json')).toEqual([]);
    expect(one('')).toEqual([]);
    expect(one(JSON.stringify({ type: 'attachment', message: { content: 'x' } }))).toEqual([]);
  });
});

describe('text cap', () => {
  it('cuts at THREAD_TEXT_CAP and flags truncated; exact-cap text is not flagged', () => {
    const over = one(user('a'.repeat(THREAD_TEXT_CAP + 1)))[0] as { text: string; truncated: boolean };
    expect(over.text).toHaveLength(THREAD_TEXT_CAP);
    expect(over.truncated).toBe(true);
    const exact = one(asst([{ type: 'text', text: 'b'.repeat(THREAD_TEXT_CAP) }]))[0] as { truncated: boolean };
    expect(exact.truncated).toBe(false);
  });

  it('text is not masked', () => {
    const key = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(5);
    expect((one(user(`key ${key}`))[0] as { text: string }).text).toContain(key);
  });
});

describe('turnMark', () => {
  it('human prompt busy; tool_use busy; mid-turn text (stop_reason tool_use) busy', () => {
    expect(turnMark(user('go'))).toEqual({ mark: 'busy', at: AT });
    expect(turnMark(tool('Bash', { command: 'ls' }))).toEqual({ mark: 'busy', at: AT });
    expect(turnMark(asst([{ type: 'text', text: 'ok' }], {}, 'tool_use'))?.mark).toBe('busy');
  });

  it('final text (end_turn, or no stop_reason) and interrupt are idle', () => {
    expect(turnMark(asst([{ type: 'text', text: 'done' }], {}, 'end_turn'))?.mark).toBe('idle');
    expect(turnMark(asst([{ type: 'text', text: 'done' }]))?.mark).toBe('idle');
    expect(turnMark(user([{ type: 'text', text: '[Request interrupted by user]' }]))?.mark).toBe('idle');
  });

  it('tool_result, sidechain, thinking-only (no stop) and non-prompt lines say nothing', () => {
    expect(turnMark(user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]))).toBeNull();
    expect(turnMark(asst([{ type: 'text', text: 'x' }], { isSidechain: true }, 'end_turn'))).toBeNull();
    expect(turnMark(asst([{ type: 'thinking', thinking: 'x' }]))).toBeNull();
    expect(turnMark(user('<system-reminder>x</system-reminder>'))).toBeNull();
    expect(turnMark('junk')).toBeNull();
  });
});

describe('fixture replay', () => {
  const lines = readFileSync(join(__dirname, '__fixtures__', 'thread-sample.jsonl'), 'utf8').split('\n').filter(Boolean);

  it('yields user, claude, Edit, Bash, Read, claude and drops tool_result/sidechain/reminder/compact lines', () => {
    const evs = lines.flatMap((l, i) => parseThreadLine(l, i));
    expect(evs.map((e) => (e.k === 'tool' ? `tool:${e.name}:${e.target}` : e.k))).toEqual([
      'user', 'claude', 'tool:Edit:KeyRow.kt', 'tool:Bash:./gradlew test', 'tool:Read:index.ts', 'claude',
    ]);
    expect(evs[2]).toMatchObject({ add: 4, del: 2 });
  });

  it('turn marks: busy through tool_results, idle only on the final text', () => {
    const marks = lines.map((l) => turnMark(l)?.mark ?? '-');
    expect(marks).toEqual(['busy', 'busy', 'busy', 'busy', '-', 'busy', '-', '-', '-', '-', 'busy', 'idle']);
  });
});
