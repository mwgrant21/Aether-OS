// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  toolUseIdFromSubagentMeta,
  countToolErrors,
  createSubagentFileProbe,
  createSubagentLinkIndex,
} from './subagentLink';

const result = (isError: boolean) =>
  JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: isError, content: 'x' }] } });
const agentUse = (id: string, name = 'Agent') =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const tmp = () => mkdtempSync(join(tmpdir(), 'aether-sub-'));

describe('subagentLink', () => {
  it('reads toolUseId from meta JSON, null on anything else', () => {
    expect(toolUseIdFromSubagentMeta('{"agentType":"x","toolUseId":"toolu_1"}')).toBe('toolu_1');
    expect(toolUseIdFromSubagentMeta('{"toolUseId":5}')).toBeNull();
    expect(toolUseIdFromSubagentMeta('{"toolUseId":{"a":1}}')).toBeNull();
    expect(toolUseIdFromSubagentMeta('null')).toBeNull();
    expect(toolUseIdFromSubagentMeta('nope')).toBeNull();
  });
  it('counts is_error:true tool_results, ignores malformed lines', () => {
    expect(countToolErrors([result(true), result(false), result(true), '{bad', '', result(true)])).toBe(3);
  });
  it('probe links a dispatch to its subagent file via meta.json', () => {
    const dir = join(tmp(), 'subagents');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-a1.meta.json'), '{"toolUseId":"toolu_A"}');
    writeFileSync(join(dir, 'agent-a1.jsonl'), [result(true), result(true), result(true)].join('\n'));
    writeFileSync(join(dir, 'agent-bad.meta.json'), '{not json');
    utimesSync(join(dir, 'agent-a1.jsonl'), 1_700_000_000, 1_700_000_000);
    const p = createSubagentFileProbe(dir);
    expect(p.toolErrorsFor('toolu_A')).toBe(3);
    expect(p.lastWriteMsFor('toolu_A')).toBe(1_700_000_000_000);
    expect(p.toolErrorsFor('toolu_missing')).toBeNull();
    expect(createSubagentFileProbe(join(dir, 'nope')).toolErrorsFor('toolu_A')).toBeNull();
  });
  it('probe accepts several dirs (same session split across projects)', () => {
    const root = tmp();
    const d1 = join(root, 'a', 'subagents');
    const d2 = join(root, 'b', 'subagents');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, 'agent-z.meta.json'), '{"toolUseId":"toolu_Z"}');
    writeFileSync(join(d2, 'agent-z.jsonl'), result(true));
    expect(createSubagentFileProbe([d1, d2]).toolErrorsFor('toolu_Z')).toBe(1);
  });
});

describe('createSubagentLinkIndex: parent lookup (spike: 202 own + 8 cross-project + 4 sibling)', () => {
  function layout() {
    const root = tmp();
    mkdirSync(join(root, 'projA'));
    mkdirSync(join(root, 'projB'));
    return root;
  }
  function addSub(root: string, proj: string, session: string, agent: string, toolUseId: string | null, lines: string[] = []) {
    const d = join(root, proj, session, 'subagents');
    mkdirSync(d, { recursive: true });
    if (toolUseId !== null) writeFileSync(join(d, `agent-${agent}.meta.json`), JSON.stringify({ toolUseId }));
    writeFileSync(join(d, `agent-${agent}.jsonl`), lines.join('\n'));
  }

  it('path 1: parent transcript in the subagent own project dir', () => {
    const root = layout();
    writeFileSync(join(root, 'projA', 'S1.jsonl'), agentUse('toolu_own') + '\n');
    addSub(root, 'projA', 'S1', 'a', 'toolu_own');
    const link = createSubagentLinkIndex(root).resolveParent('S1', 'toolu_own');
    expect(link).toEqual({ via: 'parent', file: join(root, 'projA', 'S1.jsonl') });
  });
  it('path 1: parent in ANOTHER project dir than the subagent', () => {
    const root = layout();
    writeFileSync(join(root, 'projB', 'S2.jsonl'), agentUse('toolu_x', 'Task') + '\n');
    addSub(root, 'projA', 'S2', 'a', 'toolu_x');
    const idx = createSubagentLinkIndex(root);
    expect(idx.resolveParent('S2', 'toolu_x')).toEqual({ via: 'parent', file: join(root, 'projB', 'S2.jsonl') });
    expect(idx.subagentsDirsFor('S2')).toEqual([join(root, 'projA', 'S2', 'subagents')]);
  });
  it('path 2: nested dispatch whose Agent tool_use lives in a sibling subagent jsonl', () => {
    const root = layout();
    writeFileSync(join(root, 'projA', 'S3.jsonl'), agentUse('toolu_top') + '\n');
    addSub(root, 'projA', 'S3', 'a', 'toolu_top', [agentUse('toolu_nested')]);
    addSub(root, 'projA', 'S3', 'b', 'toolu_nested');
    const link = createSubagentLinkIndex(root).resolveParent('S3', 'toolu_nested');
    expect(link).toEqual({ via: 'sibling', file: join(root, 'projA', 'S3', 'subagents', 'agent-a.jsonl') });
  });
  it('path 3: degrades to null when the tool_use is nowhere, or the parent is missing', () => {
    const root = layout();
    writeFileSync(join(root, 'projA', 'S4.jsonl'), agentUse('toolu_other') + '\n');
    addSub(root, 'projA', 'S4', 'a', 'toolu_ghost');
    addSub(root, 'projA', 'S5', 'a', 'toolu_ghost2');
    const idx = createSubagentLinkIndex(root);
    expect(idx.resolveParent('S4', 'toolu_ghost')).toBeNull();
    expect(idx.resolveParent('S5', 'toolu_ghost2')).toBeNull();
    expect(idx.resolveParent('S-none', 'toolu_ghost')).toBeNull();
  });
  it('does not match a non-Agent tool_use or a bare substring', () => {
    const root = layout();
    writeFileSync(join(root, 'projA', 'S6.jsonl'), agentUse('toolu_b', 'Bash') + '\n' + JSON.stringify({ note: 'toolu_c' }) + '\n');
    const idx = createSubagentLinkIndex(root);
    expect(idx.resolveParent('S6', 'toolu_b')).toBeNull();
    expect(idx.resolveParent('S6', 'toolu_c')).toBeNull();
  });
  it('builds its directory index once (no rescan per lookup)', () => {
    const root = layout();
    writeFileSync(join(root, 'projA', 'S7.jsonl'), agentUse('toolu_q') + '\n');
    const idx = createSubagentLinkIndex(root);
    expect(idx.resolveParent('S7', 'toolu_q')).not.toBeNull();
    writeFileSync(join(root, 'projA', 'late.jsonl'), agentUse('toolu_late') + '\n');
    expect(idx.resolveParent('late', 'toolu_late')).toBeNull();
  });
  it('probeFor(session) reads subagent files across project dirs; unknown session gives a null probe', () => {
    const root = layout();
    addSub(root, 'projA', 'S8', 'a', 'toolu_e', [result(true), result(true), result(true)]);
    addSub(root, 'projB', 'S8', 'b', 'toolu_f', [result(true)]);
    const idx = createSubagentLinkIndex(root);
    expect(idx.probeFor('S8').toolErrorsFor('toolu_e')).toBe(3);
    expect(idx.probeFor('S8').toolErrorsFor('toolu_f')).toBe(1);
    expect(idx.probeFor('nope').toolErrorsFor('toolu_e')).toBeNull();
  });
  it('unreadable projects root never throws', () => {
    const idx = createSubagentLinkIndex(join(tmp(), 'missing'));
    expect(idx.resolveParent('S', 't')).toBeNull();
    expect(idx.subagentsDirsFor('S')).toEqual([]);
  });
});
