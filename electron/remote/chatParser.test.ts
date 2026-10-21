// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseChatLine, type ChatParseContext } from './chatParser';
import type { ChatEvent } from './types';
import { REMOTE_BODY_CAP } from '../../src/shared/remote/types';

const TS = '2026-10-21T10:00:00.000Z';
const everything: ChatEvent[] = [];
const ctx = (): ChatParseContext => ({ dispatchIds: new Set() });
function parse(line: string, c: ChatParseContext = ctx(), off = 100): ChatEvent[] {
  const out = parseChatLine(line, off, c);
  everything.push(...out);
  return out;
}
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user', content }, ...extra });
const asst = (content: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: TS, message: { role: 'assistant', content }, ...extra });
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----';
const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
const PATH = 'C:\\Users\\Matt\\x\\y.ts';

describe('parseChatLine', () => {
  it('turns a human prompt into a you bubble', () => {
    const [e] = parse(user('hello there'));
    expect(e).toMatchObject({ k: 'msg', role: 'you', text: 'hello there', truncated: false, tools: [], id: '100:0', atMs: Date.parse(TS) });
  });

  it('masks key, password, bearer and PEM in human text', () => {
    const text = `a ${KEY} b password=hunter2hunter2 c Bearer abcdefghijklmnopqrstuvwxyz0123 d ${PEM}`;
    const [e] = parse(user(text));
    const t = (e as Extract<ChatEvent, { k: 'msg' }>).text;
    expect(t).not.toMatch(/sk-ant|hunter2|abcdefghijklmnopqrstuvwxyz0123|MIIEabc|BEGIN RSA/);
    expect(t).toContain('[redacted]');
  });

  it('masks before capping: a key straddling the cap leaves no prefix', () => {
    const text = 'x'.repeat(REMOTE_BODY_CAP - 10) + ' ' + KEY + ' tail';
    const [e] = parse(user(text));
    const m = e as Extract<ChatEvent, { k: 'msg' }>;
    expect(m.truncated).toBe(true);
    expect(m.text).not.toContain('sk-');
    expect(m.text.length).toBeLessThanOrEqual(REMOTE_BODY_CAP);
  });

  it('assistant text + Bash tool: names only, no command or path anywhere', () => {
    const line = asst([
      { type: 'text', text: 'running it' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `cat ${PATH} && echo secretcmd` } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
      { type: 'thinking', thinking: 'private musings' },
    ]);
    const out = parse(line);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'claude', text: 'running it', tools: ['Bash'] });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/secretcmd|y\.ts|C:|musings/);
  });

  it('masks a secret inside assistant text', () => {
    const [e] = parse(asst([{ type: 'text', text: `token is ${KEY}` }]));
    expect(JSON.stringify(e)).not.toContain('sk-ant');
  });

  it('assistant with only tools emits a bubble with empty text', () => {
    const [e] = parse(asst([{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: PATH } }]));
    expect(e).toMatchObject({ role: 'claude', text: '', tools: ['Read'] });
    expect(JSON.stringify(e)).not.toContain('y.ts');
  });

  it('Agent dispatch: bubble without Agent in tools plus a dispatch card with path-free labels', () => {
    const c = ctx();
    const out = parse(
      asst([
        { type: 'text', text: 'delegating' },
        { type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { subagent_type: 'builder', description: `fix ${PATH} now`, prompt: `do ${KEY}` } },
      ]),
      c,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ k: 'msg', tools: [] });
    expect(out[1]).toMatchObject({ k: 'traffic', kind: 'dispatch', from: 'Claude', to: 'builder', subject: 'fix y.ts now', id: '100:1' });
    expect(JSON.stringify(out)).not.toContain('sk-ant');
    expect(c.dispatchIds.has('toolu_A')).toBe(true);
  });

  it('SendMessage becomes a message card; * becomes everyone; hex id becomes agent', () => {
    const send = (to: string) =>
      asst([{ type: 'tool_use', id: 'toolu_S', name: 'SendMessage', input: { to, summary: 'sum', message: 'hi' } }]);
    expect(parse(send('*'))[0]).toMatchObject({ k: 'traffic', kind: 'message', to: 'everyone', subject: 'sum', text: 'hi' });
    expect(parse(send('a1b2c3d4e5f6a7b8'))[0]).toMatchObject({ to: 'agent' });
    expect(parse(send('reviewer'))[0]).toMatchObject({ to: 'reviewer' });
  });

  it('drops non-chat lines', () => {
    expect(parse(user('<system-reminder>x</system-reminder>'))).toEqual([]);
    expect(parse(user('<command-name>/x</command-name>'))).toEqual([]);
    expect(parse(user('meta', { isMeta: true }))).toEqual([]);
    expect(parse(user('side', { isSidechain: true }))).toEqual([]);
    expect(parse(user('summary', { isCompactSummary: true }))).toEqual([]);
    expect(parse(user('hello', { origin: { kind: 'coordinator' } }))).toEqual([]);
    expect(parse(user([{ type: 'tool_result', tool_use_id: 'x', content: `out ${PATH}` }]))).toEqual([]);
    expect(parse(asst([{ type: 'text', text: 'side' }], { isSidechain: true }))).toEqual([]);
    expect(parse('{not json')).toEqual([]);
    expect(parse('')).toEqual([]);
  });

  it('hand-back via task-notification needs a known dispatch id', () => {
    const n = `<task-notification><task-id>b1</task-id><tool-use-id>toolu_A</tool-use-id><status>completed</status><summary>Agent done in ${PATH}</summary><result>all good ${KEY}</result></task-notification>`;
    const line = user(n, { origin: { kind: 'task-notification' } });
    expect(parse(line, ctx())).toEqual([]);
    const c = ctx();
    c.dispatchIds.add('toolu_A');
    const out = parse(line, c);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ k: 'traffic', kind: 'handback', from: 'agent', to: 'Claude', status: 'completed' });
    expect(JSON.stringify(out)).not.toContain('sk-ant');
    expect((out[0] as Extract<ChatEvent, { k: 'traffic' }>).subject).toBe('Agent done in y.ts');
  });

  it('peer hand-back becomes a handback card with a path-free from', () => {
    const line = user('<agent-message from="abc">[Subagent hand-back] done</agent-message>', {
      origin: { kind: 'peer', name: `W ${PATH}`, handback: true },
    });
    const out = parse(line);
    expect(out[0]).toMatchObject({ k: 'traffic', kind: 'handback', to: 'Claude', from: 'W y.ts' });
  });
});

it('property: no label carries a path and no event carries a key', () => {
  // Property over every event produced above: from/to/subject are path-free.
  expect(everything.length).toBeGreaterThan(8);
  for (const e of everything) {
    if (e.k !== 'traffic') continue;
    for (const f of [e.from, e.to, e.subject ?? '']) {
      expect(f).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(f).not.toMatch(/\\\\[^\s]+\\/);
    }
  }
  expect(JSON.stringify(everything)).not.toContain('sk-ant');
});
