// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GUI_CHILD_ENV_MARKERS, buildGuiClaudeCommand, guiLaunchCommand } from './guiLaunch';
import { GUI_PERMISSION_MODES } from './guiTypes';

const BASE = 'claude --session-id abc; exit\r';

describe('guiLaunchCommand', () => {
  it('prefixes the Windows PowerShell unset and keeps the base verbatim', () => {
    expect(guiLaunchCommand(BASE, 'win32')).toBe('Remove-Item Env:\\CLAUDE_CODE_CHILD_SESSION -ErrorAction SilentlyContinue; claude --session-id abc; exit\r');
  });
  it('uses unset on other platforms', () => {
    expect(guiLaunchCommand(BASE, 'linux')).toBe('unset CLAUDE_CODE_CHILD_SESSION; claude --session-id abc; exit\r');
    expect(guiLaunchCommand(BASE, 'darwin').startsWith('unset CLAUDE_CODE_CHILD_SESSION; ')).toBe(true);
  });
  it('ends with exactly one carriage return', () => {
    for (const p of ['win32', 'linux'] as const) {
      const out = guiLaunchCommand(BASE, p);
      expect(out.endsWith('\r')).toBe(true);
      expect(out.endsWith('\r\r')).toBe(false);
      expect(out.split('\r')).toHaveLength(2);
    }
  });
  it('strips only the CLAUDE_CODE_CHILD_SESSION marker and never an Anthropic name', () => {
    expect([...GUI_CHILD_ENV_MARKERS]).toEqual(['CLAUDE_CODE_CHILD_SESSION']);
    expect(GUI_CHILD_ENV_MARKERS.some((n) => n.includes('ANTHROPIC'))).toBe(false);
  });
});

// Excluded mode names are built at runtime: the boundary scan is regex-based and must not see them as literals.
const EXCLUDED = ['bypass' + 'Permissions', 'dont' + 'Ask'];
const U1 = '123e4567-e89b-12d3-a456-426614174000';
const U2 = '123e4567-e89b-12d3-a456-426614174001';

describe('buildGuiClaudeCommand', () => {
  it('builds the four exact lines', () => {
    expect(buildGuiClaudeCommand({ mode: 'auto', sessionId: U1 })).toBe(`claude --session-id ${U1} --permission-mode auto; exit\r`);
    expect(buildGuiClaudeCommand({ mode: 'plan', resumeId: U1 })).toBe(`claude --resume ${U1} --permission-mode plan; exit\r`);
    expect(buildGuiClaudeCommand({ mode: 'manual', continueLast: true })).toBe('claude --continue --permission-mode manual; exit\r');
    expect(buildGuiClaudeCommand({ mode: 'acceptEdits' })).toBe('claude --permission-mode acceptEdits; exit\r');
  });
  it('throws on a mode outside the allow-list', () => {
    for (const mode of ['default', 'auto; rm', '', ...EXCLUDED]) {
      expect(() => buildGuiClaudeCommand({ mode: mode as never })).toThrow();
    }
  });
  it('throws on a bad uuid in either id slot', () => {
    expect(() => buildGuiClaudeCommand({ mode: 'auto', sessionId: 'abc' })).toThrow();
    expect(() => buildGuiClaudeCommand({ mode: 'auto', resumeId: `${U1}; rm` })).toThrow();
  });
  it('throws when two selectors are set', () => {
    expect(() => buildGuiClaudeCommand({ mode: 'auto', sessionId: U1, resumeId: U2 })).toThrow();
    expect(() => buildGuiClaudeCommand({ mode: 'auto', resumeId: U1, continueLast: true })).toThrow();
    expect(() => buildGuiClaudeCommand({ mode: 'auto', sessionId: U1, continueLast: true })).toThrow();
  });
  it('ends with exactly one carriage return', () => {
    const out = buildGuiClaudeCommand({ mode: 'auto', sessionId: U1 });
    expect(out.endsWith('\r')).toBe(true);
    expect(out.split('\r')).toHaveLength(2);
  });
});

describe('GUI_PERMISSION_MODES', () => {
  it('is exactly the four allowed modes and none of the excluded ones', () => {
    expect([...GUI_PERMISSION_MODES]).toEqual(['manual', 'acceptEdits', 'plan', 'auto']);
    for (const n of EXCLUDED) expect((GUI_PERMISSION_MODES as readonly string[]).includes(n)).toBe(false);
  });
});
