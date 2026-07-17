import type { AetherState, CommandResult } from '../../state/types';

export function runCommand(_state: AetherState, _raw: string): CommandResult {
  return { kind: 'append', lines: [] };
}
