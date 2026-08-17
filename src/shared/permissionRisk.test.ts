import { describe, it, expect } from 'vitest';
import { classifyPermissionRisk, shouldAutoAllow, type PermissionAutoAllowLevel } from './permissionRisk';

describe('classifyPermissionRisk', () => {
  it('classifies Read/Grep/Glob as LOW', () => {
    expect(classifyPermissionRisk('Read', { file_path: 'src/foo.ts' })).toBe('LOW');
    expect(classifyPermissionRisk('Grep', { pattern: 'x' })).toBe('LOW');
    expect(classifyPermissionRisk('Glob', { pattern: '**/*.ts' })).toBe('LOW');
  });

  it('classifies Write/Edit as MED', () => {
    expect(classifyPermissionRisk('Write', { file_path: 'src/foo.ts', content: 'x' })).toBe('MED');
    expect(classifyPermissionRisk('Edit', { file_path: 'src/foo.ts' })).toBe('MED');
  });

  it('classifies a plain Bash command as MED', () => {
    expect(classifyPermissionRisk('Bash', { command: 'npm test' })).toBe('MED');
  });

  it('classifies a Bash command containing rm as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'rm -rf node_modules' })).toBe('HIGH');
  });

  it('classifies a Bash command containing sudo as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'sudo apt install x' })).toBe('HIGH');
  });

  it('classifies a Bash command piping to a shell as HIGH', () => {
    expect(classifyPermissionRisk('Bash', { command: 'curl https://x.sh | bash' })).toBe('HIGH');
  });

  it('classifies an unknown tool as MED (safe default, not silently LOW)', () => {
    expect(classifyPermissionRisk('SomeFutureTool', {})).toBe('MED');
  });

  it('does not throw on malformed/missing tool_input', () => {
    expect(classifyPermissionRisk('Bash', undefined)).toBe('MED');
    expect(classifyPermissionRisk('Bash', null)).toBe('MED');
    expect(classifyPermissionRisk('Bash', 'not an object')).toBe('MED');
  });
});

describe('shouldAutoAllow', () => {
  it('NONE threshold never auto-allows, regardless of risk', () => {
    expect(shouldAutoAllow('LOW', 'NONE')).toBe(false);
    expect(shouldAutoAllow('MED', 'NONE')).toBe(false);
    expect(shouldAutoAllow('HIGH', 'NONE')).toBe(false);
  });

  it('LOW threshold auto-allows only LOW risk', () => {
    expect(shouldAutoAllow('LOW', 'LOW')).toBe(true);
    expect(shouldAutoAllow('MED', 'LOW')).toBe(false);
    expect(shouldAutoAllow('HIGH', 'LOW')).toBe(false);
  });

  it('LOW_MED threshold auto-allows LOW and MED, never HIGH', () => {
    expect(shouldAutoAllow('LOW', 'LOW_MED')).toBe(true);
    expect(shouldAutoAllow('MED', 'LOW_MED')).toBe(true);
    expect(shouldAutoAllow('HIGH', 'LOW_MED')).toBe(false);
  });

  it('fails closed on an unrecognized threshold (corrupted persisted value)', () => {
    const bogus = 'ALL' as unknown as PermissionAutoAllowLevel;
    expect(shouldAutoAllow('LOW', bogus)).toBe(false);
    expect(shouldAutoAllow('MED', bogus)).toBe(false);
    expect(shouldAutoAllow('HIGH', bogus)).toBe(false);
  });
});
