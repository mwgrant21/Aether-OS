import { describe, it, expect } from 'vitest';
import { buildScheduledTaskCommand } from './autostart.js';

describe('buildScheduledTaskCommand', () => {
  it('builds a /Create command with ONLOGON trigger, no elevation, quoted paths', () => {
    const argv = buildScheduledTaskCommand('create', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\test\\aether-os\\collector\\dist\\index.js');
    expect(argv).toEqual([
      '/Create',
      '/TN', 'AetherCollector',
      '/TR', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\aether-os\\collector\\dist\\index.js"',
      '/SC', 'ONLOGON',
      '/RL', 'LIMITED',
      '/F',
    ]);
  });

  it('builds a /Delete command by task name only', () => {
    const argv = buildScheduledTaskCommand('delete', 'unused', 'unused');
    expect(argv).toEqual(['/Delete', '/TN', 'AetherCollector', '/F']);
  });
});
