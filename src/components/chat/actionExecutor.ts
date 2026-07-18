import type { ChatAction } from './actionParser';
import type { ChatChannel } from './chatChannels';
import type { Approval, OpMode } from '../../state/types';
import { THEME_NAMES, RENDERER_WORDS } from '../terminal/commands';

export const SAFE_VERBS = ['theme', 'renderer'] as const;
export const RISKY_VERBS = ['spawn', 'kill', 'throttle'] as const;

// Risk-level policy, grounded in the seed approvals' own bar (a production
// deploy is HIGH, a schema migration is MED): kill destroys an agent's
// in-flight work with no undo (HIGH); spawn adds cost/load but is reversible
// via kill (MED); throttle just caps one agent's share, fully reversible,
// minimal blast radius (LOW).
export const RISK_POLICY: Record<(typeof RISKY_VERBS)[number], Approval['risk']> = {
  kill: 'HIGH',
  spawn: 'MED',
  throttle: 'LOW',
};

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Safe verbs execute immediately, "as if the user had typed the equivalent
// Terminal command" -- literally reusing commands.ts's own theme/renderer
// validation by building the exact raw string RUN_COMMAND would receive.
export function buildSafeCommandRaw(action: ChatAction): string | null {
  if (action.verb === 'theme') {
    const name = str(action.args, 'name')?.toLowerCase();
    if (!name || !(THEME_NAMES as readonly string[]).includes(name)) return null;
    return `theme ${name}`;
  }
  if (action.verb === 'renderer') {
    const mode = str(action.args, 'mode')?.toLowerCase();
    if (!mode || !(RENDERER_WORDS as readonly string[]).includes(mode)) return null;
    return `renderer ${mode}`;
  }
  return null;
}

// Risky verbs never execute directly -- they build an Approval payload
// pushed via ADD_APPROVAL, routed back to the originating channel via
// channelId (see reducer.ts's RESOLVE_APPROVAL extension).
//
// Invariant (flagged by review, applies to ALL THREE risky verbs): must
// return null whenever args.name is missing or non-string, so verb and
// targetAgentName are always set together on the returned payload -- never
// verb-set-but-targetAgentName-missing. RESOLVE_APPROVAL relies on both
// fields being present together to execute the mutation.
export function buildApprovalPayload(channel: ChatChannel, action: ChatAction): Omit<Approval, 'id'> | null {
  if (action.verb !== 'spawn' && action.verb !== 'kill' && action.verb !== 'throttle') return null;
  const targetAgentName = str(action.args, 'name');
  if (!targetAgentName) return null;

  const risk = RISK_POLICY[action.verb];
  const actionLabel =
    action.verb === 'spawn' ? `Spawn ${targetAgentName}` : action.verb === 'kill' ? `Kill ${targetAgentName}` : `Throttle ${targetAgentName}`;

  return {
    agent: channel.name,
    i: channel.initials,
    hue: channel.hue,
    action: actionLabel,
    detail: `requested via ${channel.name} chat channel`,
    risk,
    verb: action.verb,
    targetAgentName,
    channelId: channel.id,
  };
}

// Mirrors tick.ts's existing AUTO-mode policy verbatim (`mode === 'AUTO' &&
// req.risk !== 'HIGH'`) rather than inventing a second one -- a chat-
// originated spawn/throttle request is auto-approved exactly as any other
// MED/LOW request already is in AUTO mode; kill (HIGH) never is.
export function shouldAutoApprove(risk: Approval['risk'], opMode: OpMode): boolean {
  return opMode === 'AUTO' && risk !== 'HIGH';
}
