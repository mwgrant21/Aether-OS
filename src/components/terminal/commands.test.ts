import { describe, expect, it, vi } from 'vitest';
import { runCommand, THEME_NAMES, RENDERER_WORDS, nextAutoName } from './commands';
import { initialState } from '../../state/initialState';

describe('runCommand', () => {
  it('help lists every documented command', () => {
    const result = runCommand(initialState, 'help');
    expect(result.kind).toBe('append');
    if (result.kind !== 'append') throw new Error('unreachable');
    const text = result.lines.map((l) => l.t).join('\n');
    ['status', 'agents', 'spawn <name>', 'kill <name>', 'budget', 'projects', 'approvals', 'approve <n>', 'deny <n>', 'theme <name>', 'renderer <mode>'].forEach(
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

  it('exports THEME_NAMES, RENDERER_WORDS, and nextAutoName for reuse by the chat action executor', () => {
    expect(THEME_NAMES).toContain('violet');
    expect(RENDERER_WORDS).toContain('volumetric');
    expect(nextAutoName(initialState)).toBe('Image Gen');
  });
});

describe('approvals/approve/deny against real pending requests', () => {
  const permissionRequest = { requestId: 'r1', toolName: 'Write', toolInput: { file_path: 'x.ts' }, risk: 'MED' as const, editableField: null };
  const flagRequest = { requestId: 'f1', toolUseId: 't1', toolName: 'Bash', anomalyKind: 'stalledPermission' as const, detail: 'ran 90s' };

  it('approvals lists both real pending requests when present', () => {
    const state = { ...initialState, pendingPermissionRequest: permissionRequest, pendingPostToolFlag: flagRequest };
    const result = runCommand(state, 'approvals');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('Write'))).toBe(true);
    expect(result.lines.some((l) => l.t.includes('Bash'))).toBe(true);
  });

  it('approvals colors risk 3-way: HIGH red, MED amber, LOW green', () => {
    const colorFor = (risk: 'HIGH' | 'MED' | 'LOW') => {
      const state = { ...initialState, pendingPermissionRequest: { ...permissionRequest, risk } };
      const result = runCommand(state, 'approvals');
      if (result.kind !== 'append') throw new Error('unreachable');
      return result.lines.find((l) => l.t.includes('Write'))?.c;
    };
    expect(colorFor('HIGH')).toBe('#ff9d9d');
    expect(colorFor('MED')).toBe('#f5c66b');
    expect(colorFor('LOW')).toBe('#3be0a0');
    expect(colorFor('LOW')).not.toBe(colorFor('MED'));
  });

  it('approvals colors a post-tool flag (no risk) as the amber REVIEW entry', () => {
    const state = { ...initialState, pendingPostToolFlag: flagRequest };
    const result = runCommand(state, 'approvals');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.find((l) => l.t.includes('Bash'))?.c).toBe('#f5c66b');
  });

  it('approvals reports queue clear when nothing is pending', () => {
    const result = runCommand(initialState, 'approvals');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('queue clear'))).toBe(true);
  });

  it('approve 1 resolves the real permission request via IPC when it is first in the list', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const state = { ...initialState, pendingPermissionRequest: permissionRequest };
    const result = runCommand(state, 'approve 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(respond).toHaveBeenCalledWith('r1', { behavior: 'allow', updatedInput: permissionRequest.toolInput });
  });

  it('deny 1 resolves the real permission request as denied via IPC', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const state = { ...initialState, pendingPermissionRequest: permissionRequest };
    const result = runCommand(state, 'deny 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(respond).toHaveBeenCalledWith('r1', { behavior: 'deny', reason: 'denied via Terminal' });
  });

  it('approve on an out-of-range index reports an error and calls no IPC', () => {
    const respond = vi.fn();
    (window as any).aetherElectron = { permission: { respond }, postToolFlag: { respond: vi.fn() } };
    const result = runCommand(initialState, 'approve 1');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines.some((l) => l.t.includes('no request'))).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('status context line', () => {
  const withStatusline = (capturedAtMs: number) => ({
    ...initialState,
    statusline: {
      capturedAtMs,
      sessionId: null,
      modelId: null,
      modelDisplayName: null,
      fiveHour: null,
      sevenDay: null,
      contextUsedPercentage: 55,
      contextWindowSize: 200_000,
      contextUsage: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 20,
      },
      totalCostUsd: null,
      currentDir: null,
      projectDir: null,
    },
  });

  const contextLine = (state: typeof initialState) => {
    const result = runCommand(state, 'status');
    if (result.kind !== 'append') throw new Error('unreachable');
    return result.lines.map((l) => l.t).find((t) => t.includes('context')) ?? '';
  };

  it('marks a stale reading rather than printing it as current', () => {
    // The footer card annotates the same data with `~` and `stale`. A
    // days-old snapshot printed here without qualification reads as a live
    // measurement -- see the Codex review of PR #26.
    const line = contextLine(withStatusline(Date.now() - 14 * 24 * 60 * 60 * 1000));
    expect(line).toContain('stale');
  });

  it('does not mark a fresh reading as stale', () => {
    const line = contextLine(withStatusline(Date.now()));
    expect(line).not.toContain('stale');
    expect(line).toContain('1,070');
  });
});
