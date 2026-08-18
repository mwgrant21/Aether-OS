import type { AetherState } from '../../state/types';
import type { CommsChannel } from './commsChannels';
import { fmt, fmtEta } from '../../utils/format';

// The one piece of "interesting" logic in Phase 1: a keyword-driven,
// state-aware canned responder, in the same spirit as
// `components/terminal/commands.ts`'s `runCommand` -- a switch over
// recognized phrases producing contextual (not randomly-cycled) text. Phase 2
// treats this as the offline/failure fallback for the real Claude-backed
// responder (see `useCommsChannels.ts`), so it must always return *something*
// usable, never throw, and never return an empty string.
function aetherReply(text: string, state: AetherState): string {
  const t = text.toLowerCase();
  const agentCount = state.realAgents.length;
  const pendingCount = (state.pendingPermissionRequest ? 1 : 0) + (state.pendingPostToolFlag ? 1 : 0);

  if (/budget|spend|\bcap\b|cost/.test(t)) {
    const remaining = Math.max(0, state.cfg.capM * 1e6 - state.used);
    return `${fmt(remaining)} tokens remain of the ${state.cfg.capM.toFixed(1)}M cap — depletes in ${fmtEta(remaining / (state.rate / 60))} at the current draw.`;
  }
  if (/burn|\brate\b|\btok/.test(t)) {
    return `Burn rate holding at ${fmt(state.rate)} tok/min across ${agentCount} active agent${agentCount === 1 ? '' : 's'}.`;
  }
  if (/alarm|alert|health|status/.test(t)) {
    const label = state.alarmLevel === 'crit' ? 'critical' : state.alarmLevel === 'warn' ? 'elevated' : 'nominal';
    return `Reactor status: ${label}. ${agentCount} agent${agentCount === 1 ? '' : 's'} active, ${pendingCount} pending authorization${pendingCount === 1 ? '' : 's'}.`;
  }
  if (/agent|team|roster|\bwho\b/.test(t)) {
    if (!agentCount) return 'No agents are active right now.';
    return `${agentCount} active: ${state.realAgents.map((a) => a.subagentType).join(', ')}.`;
  }
  if (/approv|pending|queue/.test(t)) {
    return pendingCount
      ? `${pendingCount} request${pendingCount === 1 ? '' : 's'} pending authorization — check the queue.`
      : 'Approval queue is clear.';
  }
  if (/\b(hi|hello|hey)\b/.test(t)) {
    return 'AETHER online. State your query — burn rate, budget, roster, or approvals.';
  }
  if (/thanks|thank you/.test(t)) {
    return 'Acknowledged.';
  }
  return `Acknowledged: "${text.trim().slice(0, 60)}". Ask about burn rate, budget, roster, or approvals for a live readout.`;
}

// Only ever invoked for the AETHER channel -- see MessageInput.tsx/CommsView.tsx's
// "What happens to localResponder" decision. The `channel` param is kept in the
// signature for that call site's shape, not because any other channel kind
// reaches this function.
export function localResponder(_channel: CommsChannel, text: string, state: AetherState): string {
  return aetherReply(text, state);
}
