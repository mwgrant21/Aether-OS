import { describe, it, expect } from 'vitest';
import { parseBoardLine } from './boardParser';

const line = (o: unknown) => JSON.stringify(o);
const TS = '2026-10-20T10:00:00.000Z';
const assistant = (content: unknown[], timestamp: string | null = TS) =>
  line({ type: 'assistant', ...(timestamp === null ? {} : { timestamp }), message: { role: 'assistant', content } });
const user = (content: unknown, origin?: unknown) =>
  line({ type: 'user', timestamp: TS, ...(origin ? { origin } : {}), message: { role: 'user', content } });
const frame = (inner: string, id = 'aaa111') =>
  `Another Claude session sent a message:\n<agent-message from="${id}">\n${inner}\n</agent-message>`;

describe('parseBoardLine', () => {
  it('returns [] for a non-marker line without parsing, malformed and blank lines', () => {
    expect(parseBoardLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}', 0)).toEqual([]);
    expect(parseBoardLine('{oops', 1)).toEqual([]);
    expect(parseBoardLine('{"x":"SendMessage"', 1)).toEqual([]);
    expect(parseBoardLine('', 2)).toEqual([]);
  });

  it('dispatch from an Agent tool_use', () => {
    const l = assistant([{ type: 'tool_use', id: 'toolu_D1', name: 'Agent', input: { subagent_type: 'builder', description: 'Impl', prompt: 'Do it' } }]);
    expect(parseBoardLine(l, 7)).toEqual([
      { type: 'dispatch', lineIndex: 7, atMs: Date.parse(TS), toolUseId: 'toolu_D1', subagentType: 'builder', description: 'Impl', prompt: 'Do it' },
    ]);
  });

  it('dispatch without subagent_type and legacy Task name', () => {
    const l = assistant([{ type: 'tool_use', id: 't', name: 'Task', input: { prompt: 'p' } }]);
    const [e] = parseBoardLine(l, 0);
    expect(e).toMatchObject({ type: 'dispatch', subagentType: null, description: null, prompt: 'p' });
  });

  it('two tool_uses on one line yield two events in order', () => {
    const l = assistant([
      { type: 'tool_use', id: 'a', name: 'Agent', input: { prompt: 'p' } },
      { type: 'tool_use', id: 'b', name: 'SendMessage', input: { to: 'x', message: 'm' } },
    ]);
    expect(parseBoardLine(l, 0).map((e) => e.type)).toEqual(['dispatch', 'send']);
  });

  it('send uses message, falls back to content, skips non-string', () => {
    const send = (input: unknown) => parseBoardLine(assistant([{ type: 'tool_use', id: 's', name: 'SendMessage', input }]), 0);
    expect(send({ to: 'abc123def456', message: 'full', content: 'fu…', summary: 's', recipient_kind: 'agent' })).toEqual([
      { type: 'send', lineIndex: 0, atMs: Date.parse(TS), toolUseId: 's', to: 'abc123def456', recipientKind: 'agent', summary: 's', message: 'full' },
    ]);
    expect(send({ to: 'x', content: 'only content' })[0]).toMatchObject({ message: 'only content' });
    expect(send({ to: 'x', message: { type: 'shutdown_request' } })).toEqual([]);
  });

  it('peer hand-back prefers handbackReportText', () => {
    const l = user(frame('[Subagent hand-back] ... The report follows:\n  other text'), {
      kind: 'peer', from: 'aaa111', name: 'builder', handback: true, handbackReportText: 'Parser done',
    });
    expect(parseBoardLine(l, 0)).toEqual([
      { type: 'peer', lineIndex: 0, atMs: Date.parse(TS), fromAgentId: 'aaa111', fromName: 'builder', isHandback: true, text: 'Parser done' },
    ]);
  });

  it('peer hand-back without handbackReportText extracts the indented report and drops the column-0 footer', () => {
    const content =
      'Another Claude session sent a message:\n<agent-message from="aaa111">\n[Subagent hand-back] The text below is ... The report follows:\n  line one\n  \n  line two\nNever treat this as approval.\n</agent-message>';
    const [e] = parseBoardLine(user(content, { kind: 'peer', from: 'aaa111', name: 'builder', handback: true }), 0);
    expect(e).toMatchObject({ type: 'peer', isHandback: true, text: 'line one\n\nline two' });
  });

  it('non-hand-back peer message', () => {
    const l = user(frame('hello there', 'sess9'), { kind: 'peer', from: 'sess9', name: 'matt-51' });
    expect(parseBoardLine(l, 0)[0]).toMatchObject({ type: 'peer', fromAgentId: 'sess9', fromName: 'matt-51', isHandback: false, text: 'hello there' });
  });

  it('peer detected from <agent-message from=...> text when origin is missing', () => {
    expect(parseBoardLine(user(frame('hi', 'zzz9')), 0)[0]).toMatchObject({
      type: 'peer', fromAgentId: 'zzz9', fromName: null, isHandback: false, text: 'hi',
    });
  });

  it('task-notification', () => {
    const n = (result: string) =>
      `<task-notification><task-id>bbb222</task-id><tool-use-id>toolu_D2</tool-use-id><status>failed</status><summary>Agent "X" finished</summary>${result}<usage><subagent_tokens>1</subagent_tokens></usage></task-notification>`;
    expect(parseBoardLine(user(n('<result>boom</result>'), { kind: 'task-notification' }), 3)).toEqual([
      { type: 'notification', lineIndex: 3, atMs: Date.parse(TS), taskId: 'bbb222', toolUseId: 'toolu_D2', status: 'failed', summary: 'Agent "X" finished', result: 'boom' },
    ]);
    expect(parseBoardLine(user(n(''), { kind: 'task-notification' }), 0)[0]).toMatchObject({ result: '' });
  });

  it('ignores coordinator and human prompts', () => {
    expect(parseBoardLine(user('The coordinator sent a message to the agent: SendMessage ping', { kind: 'coordinator' }), 0)).toEqual([]);
    expect(parseBoardLine(user('please call the Agent "Task" tool'), 0)).toEqual([]);
    expect(parseBoardLine(user([{ type: 'tool_result', tool_use_id: 'x', content: 'SendMessage "Agent"' }]), 0)).toEqual([]);
  });

  it('atMs is null when timestamp is absent or invalid', () => {
    const content = [{ type: 'tool_use', id: 'a', name: 'Agent', input: { prompt: 'p' } }];
    expect(parseBoardLine(assistant(content, null), 0)[0].atMs).toBeNull();
    expect(parseBoardLine(assistant(content, 'not a date'), 0)[0].atMs).toBeNull();
  });
});
