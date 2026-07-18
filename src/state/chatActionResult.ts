import type { Approval } from './types';

export function buildChatActionResultText(req: Approval, approved: boolean): string {
  if (!approved) return `✗ Denied: ${req.action}.`;
  switch (req.verb) {
    case 'spawn':
      return `✓ Approved — ${req.targetAgentName} spawned.`;
    case 'kill':
      return `✓ Approved — ${req.targetAgentName} terminated.`;
    case 'throttle':
      return `✓ Approved — ${req.targetAgentName}'s draw throttled.`;
    default:
      return `✓ Approved: ${req.action}.`;
  }
}
