import { describe, expect, it } from 'vitest';
import { runCommand, THEME_NAMES, RENDERER_WORDS, nextAutoName } from './commands';
import { initialState } from '../../state/initialState';

describe('runCommand', () => {
  it('help lists every documented command', () => {
    const result = runCommand(initialState, 'help');
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') throw new Error('unreachable');
    const text = result.lines.map((l) => l.t).join('\n');
    ['status', 'agents', 'spawn <name>', 'kill <name>', 'budget', 'projects', 'sweep', 'remember <text>', 'approvals', 'approve <n>', 'deny <n>', 'theme <name>', 'renderer <mode>', 'clear'].forEach(
      (cmd) => expect(text).toContain(cmd),
    );
  });

  it('unknown command returns an error line, no patch', () => {
    const result = runCommand(initialState, 'frobnicate');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('unknown command: frobnicate');
    expect(result.patch).toBeUndefined();
  });

  it('spawn <name> adds a named agent and raises the burn rate by 18000', () => {
    const result = runCommand(initialState, 'spawn Sentinel');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents).toHaveLength(initialState.agents.length + 1);
    expect(result.patch?.agents?.at(-1)?.name).toBe('Sentinel');
    expect(result.patch?.rate).toBe(initialState.rate + 18000);
  });

  it('spawn with no name picks the first unused name from the auto pool', () => {
    const result = runCommand(initialState, 'spawn');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents?.at(-1)?.name).toBe('Image Gen');
  });

  it('kill removes a matching agent case-insensitively and moves it to idleList', () => {
    const result = runCommand(initialState, 'kill code builder');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.agents?.map((a) => a.name)).not.toContain('Code Builder');
    expect(result.patch?.idleList?.at(-1)).toEqual({ name: 'Code Builder', last: 'just now' });
  });

  it('kill on an unknown agent reports an error with no patch', () => {
    const result = runCommand(initialState, 'kill nobody');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('no agent named "nobody"');
    expect(result.patch).toBeUndefined();
  });

  it('kill appends a memory referencing the terminated agent', () => {
    const result = runCommand(initialState, 'kill code builder');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.memories).toHaveLength(initialState.memories.length + 1);
    expect(result.patch?.memories?.at(-1)?.name).toBe('Code Builder decommissioned');
    expect(result.patch?.memSeq).toBe(initialState.memSeq + 1);
  });

  it('theme accepts only the six known names', () => {
    const ok = runCommand(initialState, 'theme violet');
    if (ok.kind !== 'append') throw new Error('unreachable');
    expect(ok.patch?.cfg?.theme).toBe('violet');

    const bad = runCommand(initialState, 'theme plaid');
    if (bad.kind !== 'append') throw new Error('unreachable');
    expect(bad.patch).toBeUndefined();
  });

  it('renderer maps "nebula" to the internal "classic" key', () => {
    const result = runCommand(initialState, 'renderer nebula');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.cfg?.renderer).toBe('classic');
  });

  it('approve on a HIGH risk request raises the rate by 9000; deny does not, and says "denied" not "denyd"', () => {
    const approve = runCommand(initialState, 'approve 1');
    if (approve.kind !== 'append') throw new Error('unreachable');
    expect(approve.patch?.rate).toBe(initialState.rate + 9000);
    expect(approve.patch?.approvals?.map((a) => a.id)).toEqual([2]);

    const deny = runCommand(initialState, 'deny 2');
    if (deny.kind !== 'append') throw new Error('unreachable');
    expect(deny.patch?.rate).toBe(initialState.rate);
    expect(deny.lines[1].t).toContain('denied');
    expect(deny.lines[1].t).not.toContain('denyd');
  });

  it('approve/deny on an out-of-range index reports an error', () => {
    const result = runCommand(initialState, 'approve 99');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('no request [99]');
  });

  it('approve on a HIGH-risk request appends a memory; a MED-risk deny does not', () => {
    const approveHigh = runCommand(initialState, 'approve 1');
    if (approveHigh.kind !== 'append') throw new Error('unreachable');
    expect(approveHigh.patch?.memories?.at(-1)?.name).toBe('Approved: Deploy build #214 to production');
    expect(approveHigh.patch?.memSeq).toBe(initialState.memSeq + 1);

    const denyMed = runCommand(initialState, 'deny 2');
    if (denyMed.kind !== 'append') throw new Error('unreachable');
    expect(denyMed.patch?.memories).toEqual(initialState.memories);
    expect(denyMed.patch?.memSeq).toBe(initialState.memSeq);
  });

  it('deny on a HIGH-risk request also appends a memory', () => {
    const denyHigh = runCommand(initialState, 'deny 1');
    if (denyHigh.kind !== 'append') throw new Error('unreachable');
    expect(denyHigh.patch?.memories?.at(-1)?.name).toBe('Denied: Deploy build #214 to production');
    expect(denyHigh.patch?.memSeq).toBe(initialState.memSeq + 1);
  });

  it('remember <text> logs a manual memory at full strength', () => {
    const result = runCommand(initialState, 'remember check the CDN purge before next deploy');
    if (result.kind !== 'append') throw new Error('unreachable');
    const added = result.patch?.memories?.at(-1);
    expect(added?.content).toBe('check the CDN purge before next deploy');
    expect(added?.source).toBe('operator');
    expect(added?.pinned).toBe(false);
    expect(added?.strength).toBe(100);
    expect(result.patch?.memSeq).toBe(initialState.memSeq + 1);
  });

  it('remember with no text reports a usage error and no patch', () => {
    const result = runCommand(initialState, 'remember');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('usage: remember <text>');
    expect(result.patch).toBeUndefined();
  });

  it('clear returns the clear variant', () => {
    expect(runCommand(initialState, 'clear')).toEqual({ kind: 'clear' });
  });

  it('exports THEME_NAMES, RENDERER_WORDS, and nextAutoName for reuse by the chat action executor', () => {
    expect(THEME_NAMES).toContain('violet');
    expect(RENDERER_WORDS).toContain('volumetric');
    expect(nextAutoName(initialState)).toBe('Image Gen');
  });
});
