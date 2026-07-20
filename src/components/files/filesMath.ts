import type { Agent, AgentFile } from '../../state/types';

const PLACEHOLDER_FILE_NAMES = new Set(['booting runtime…', 'awaiting mission']);

export function groupFilesByAgent(agents: Agent[]): { name: string; i: string; hue: string; files: AgentFile[] }[] {
  return agents
    .map((a) => ({ name: a.name, i: a.i, hue: a.hue, files: a.files.filter((f) => !PLACEHOLDER_FILE_NAMES.has(f.n)) }))
    .filter((g) => g.files.length > 0);
}
