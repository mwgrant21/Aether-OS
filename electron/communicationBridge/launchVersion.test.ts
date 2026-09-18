// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightBridgeLaunch } from './launchConfig';

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async original => {
  const { promisify } = await import('node:util');
  return { ...await original<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: commands.run }) };
});
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  lstat: vi.fn(async () => ({ isFile: () => true })),
  readFile: vi.fn(async () => { throw Object.assign(new Error('absent fixture config'), { code: 'ENOENT' }); }),
}));
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  commands.run.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('native version gate through launch preflight', () => {
  it.each([
    ['2.1.274 (Claude Code)', true],
    [' \t2.1.274 (Claude Code)\r\n', true],
    ['2.1.274\t(Claude Code)', true],
    ['2.1.274\n(Claude Code)', true],
    ['2.1.274\u00a0(Claude Code)', true],
    ['2.1.274\u2028(Claude Code)', true],
    ['2.1.274', false],
    ['2.1.274 \t\r\n', false],
    ['v2.1.274 (Claude Code)', false],
    ['2.1.2740 (Claude Code)', false],
    ['2.1.274-beta (Claude Code)', false],
    ['2x1x274 (Claude Code)', false],
    ['2.1.270 (Claude Code)', false],
    ['2.1.274\u200b(Claude Code)', false],
  ])('checks trimmed native output %j (accepted=%s)', async (stdout, accepted) => {
    commands.run.mockResolvedValueOnce({ stdout: '' }) // No managed registry policy.
      .mockResolvedValueOnce({ stdout: 'C:/fixture/claude.exe\r\n' })
      .mockResolvedValueOnce({ stdout });
    const preflight = preflightBridgeLaunch({ helperPath: '/fixture/helper.js', nodePath: '/fixture/node.exe', sourceEnv: {} });
    if (accepted) await expect(preflight).resolves.toBe('C:/fixture/claude.exe');
    else await expect(preflight).rejects.toThrow('CLAUDE_VERSION_REPROBE_REQUIRED');
    expect(commands.run).toHaveBeenCalledTimes(3);
    expect(commands.run.mock.calls[1][1].at(-1)).toContain('Get-Command claude');
    expect(commands.run.mock.calls[2].slice(0, 2)).toEqual(['C:/fixture/claude.exe', ['--version']]);
  });
});
