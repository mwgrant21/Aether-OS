export type PermissionRisk = 'LOW' | 'MED' | 'HIGH';

export type PermissionAutoAllowLevel = 'NONE' | 'LOW' | 'LOW_MED';

const HIGH_RISK_BASH_PATTERN = /\brm\b|\bsudo\b|\|\s*(ba|z|)sh\b|\bcurl\b.*\|\s*(ba|z|)sh\b/i;
const LOW_RISK_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const MED_RISK_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function stringField(input: unknown, field: string): string {
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function classifyPermissionRisk(toolName: string, toolInput: unknown): PermissionRisk {
  if (toolName === 'Bash') {
    const command = stringField(toolInput, 'command');
    return HIGH_RISK_BASH_PATTERN.test(command) ? 'HIGH' : 'MED';
  }
  if (LOW_RISK_TOOLS.has(toolName)) return 'LOW';
  if (MED_RISK_TOOLS.has(toolName)) return 'MED';
  return 'MED';
}

export function shouldAutoAllow(risk: PermissionRisk, threshold: PermissionAutoAllowLevel): boolean {
  if (threshold === 'NONE') return false;
  if (threshold === 'LOW') return risk === 'LOW';
  if (threshold === 'LOW_MED') return risk === 'LOW' || risk === 'MED';
  // Every PermissionAutoAllowLevel member is handled above, so this is only
  // reachable via a corrupted/stale persisted value or a future member added
  // without updating this function. Fail CLOSED (prompt) rather than falling
  // through to the most permissive behaviour.
  return false;
}
