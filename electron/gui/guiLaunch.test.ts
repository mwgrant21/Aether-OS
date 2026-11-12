// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GUI_CHILD_ENV_MARKERS, guiLaunchCommand } from './guiLaunch';

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
