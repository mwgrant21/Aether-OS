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
  it('countToolErrors pre-filter never changes the count (mixed lines)', () => {
    const spaced = '{"type":"user","message":{"content":[{"type":"tool_result","is_error": true,"content":"x"}]}}';
    // Matches the pre-filter regex but is malformed JSON: parse rejects it.
    const matchesButBroken = '{"note":"mentions "is_error": true inside" ';
    // Valid JSON the regex matches, but no tool_result carries it.
    const matchesNotToolResult = JSON.stringify({ type: 'user', is_error: true, message: { content: [{ type: 'text', text: 'is_error' }] } });
    // Text that only mentions is_error inside a string (escaped quotes): never matches.
    const mention = JSON.stringify({ message: { content: [{ type: 'tool_result', is_error: false, content: 'set "is_error": true to fail' }] } });
    expect(countToolErrors([spaced, matchesButBroken, matchesNotToolResult, mention, result(true), result(false), '', '{bad'])).toBe(2);
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
  it('probe skips a meta.json over 64 KB (no link, no throw)', () => {
    const dir = join(tmp(), 'subagents');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-big.meta.json'), JSON.stringify({ toolUseId: 'toolu_B', pad: 'x'.repeat(70 * 1024) }));
    writeFileSync(join(dir, 'agent-big.jsonl'), result(true));
    writeFileSync(join(dir, 'agent-ok.meta.json'), '{"toolUseId":"toolu_OK"}');
    writeFileSync(join(dir, 'agent-ok.jsonl'), result(true));
    const p = createSubagentFileProbe(dir);
    expect(p.toolErrorsFor('toolu_B')).toBeNull();
    expect(p.toolErrorsFor('toolu_OK')).toBe(1);
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

describe('createSubagentLinkIndex', () => {
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

  it('probeFor(session) reads subagent files across project dirs; unknown session gives a null probe', () => {
    const root = layout();
    addSub(root, 'projA', 'S8', 'a', 'toolu_e', [result(true), result(true), result(true)]);
    addSub(root, 'projB', 'S8', 'b', 'toolu_f', [result(true)]);
    const idx = createSubagentLinkIndex(root);
    expect(idx.probeFor('S8').toolErrorsFor('toolu_e')).toBe(3);
    expect(idx.probeFor('S8').toolErrorsFor('toolu_f')).toBe(1);
    expect(idx.probeFor('nope').toolErrorsFor('toolu_e')).toBeNull();
  });
  it('probeFor is lazy: nothing is resolved until the first lookup', () => {
    const root = layout();
    const idx = createSubagentLinkIndex(root);
    const p = idx.probeFor('S9');
    // Created after probeFor() returned: only a lazy probe can see it.
    addSub(root, 'projA', 'S9', 'a', 'toolu_late', [result(true), result(true)]);
    expect(p.toolErrorsFor('toolu_late')).toBe(2);
  });
  it('unreadable projects root never throws', () => {
    const idx = createSubagentLinkIndex(join(tmp(), 'missing'));
    expect(idx.subagentsDirsFor('S')).toEqual([]);
  });
});
