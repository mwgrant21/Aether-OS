import { describe, it, expect } from 'vitest';
import { buildRunKeyCommand } from './autostart.js';

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
