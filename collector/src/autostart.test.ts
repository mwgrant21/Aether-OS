import { describe, it, expect } from 'vitest';
import { buildRunKeyCommand, checkRunCommandLength } from './autostart.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

describe('buildRunKeyCommand', () => {
  it('builds a per-user Run-key add that launches the collector through a headless conhost', () => {
    const argv = buildRunKeyCommand('create', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\test\\aether-os\\collector\\dist\\index.js');
    expect(argv).toEqual([
      'add', RUN_KEY,
      '/v', 'AetherCollector',
      '/t', 'REG_SZ',
      '/d', 'conhost.exe --headless "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\aether-os\\collector\\dist\\index.js"',
      '/f',
    ]);
  });

  it('builds a delete of the Run-key value by name only', () => {
    const argv = buildRunKeyCommand('delete', 'unused', 'unused');
    expect(argv).toEqual(['delete', RUN_KEY, '/v', 'AetherCollector', '/f']);
  });
});

describe('checkRunCommandLength', () => {
  it('accepts a command of exactly 260 characters and rejects 261', () => {
    // 'conhost.exe --headless "' + node + '" "' + entry + '"' = 28 chars of framing.
    const entryFor = (total: number) => 'a'.repeat(total - 28 - 'node.exe'.length);
    expect(checkRunCommandLength(buildRunKeyCommand('create', 'node.exe', entryFor(260)))).toBeNull();
    expect(checkRunCommandLength(buildRunKeyCommand('create', 'node.exe', entryFor(261)))).toMatch(/261 characters/);
  });
});
