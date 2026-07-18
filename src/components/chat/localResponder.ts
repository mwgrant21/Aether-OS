import type { AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { fmt, fmtEta } from '../../utils/format';

// The one piece of "interesting" logic in Phase 1: a keyword-driven,
// state-aware canned responder, in the same spirit as
// `components/terminal/commands.ts`'s `runCommand` -- a switch over
// recognized phrases producing contextual (not randomly-cycled) text. Phase 2
// treats this as the offline/failure fallback for the real Claude-backed
// responder (see `useChatChannels.ts`), so it must always return *something*
// usable, never throw, and never return an empty string.
function aetherReply(text: string, state: AetherState): string {
  const t = text.toLowerCase();
  const agentCount = state.agents.length;

  if (/budget|spend|\bcap\b|cost/.test(t)) {
    const remaining = Math.max(0, state.cfg.capM * 1e6 - state.used);
    return `${fmt(remaining)} tokens remain of the ${state.cfg.capM.toFixed(1)}M cap — depletes in ${fmtEta(remaining / (state.rate / 60))} at the current draw.`;
  }
  if (/burn|\brate\b|\btok/.test(t)) {
    return `Burn rate holding at ${fmt(state.rate)} tok/min across ${agentCount} active agent${agentCount === 1 ? '' : 's'}.`;
  }
  if (/alarm|alert|health|status/.test(t)) {
    const label = state.alarmLevel === 'crit' ? 'critical' : state.alarmLevel === 'warn' ? 'elevated' : 'nominal';
    return `Reactor status: ${label}. ${agentCount} agent${agentCount === 1 ? '' : 's'} active, ${state.approvals.length} pending authorization${state.approvals.length === 1 ? '' : 's'}.`;
  }
  if (/agent|team|roster|\bwho\b/.test(t)) {
    if (!agentCount) return 'No agents are active right now. Spawn one from Terminal, Dashboard, or Agents to get started.';
    return `${agentCount} active: ${state.agents.map((a) => a.name).join(', ')}.`;
  }
  if (/approv|pending|queue/.test(t)) {
    return state.approvals.length
      ? `${state.approvals.length} request${state.approvals.length === 1 ? '' : 's'} pending authorization — check the queue.`
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

function agentReply(channel: ChatChannel, text: string, state: AetherState): string {
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    return `${channel.name} is offline — this channel is archived. Reactivate the agent from the Agents view to resume the conversation.`;
  }
  const t = text.toLowerCase();
  if (/status|how|progress|going/.test(t)) {
    return `${Math.round(agent.pct)}% through "${agent.task}", ETA ${agent.eta}.`;
  }
  if (/file|touch|working on/.test(t)) {
    if (!agent.files.length) return `No files touched yet — still ${agent.task.toLowerCase()}.`;
    return `Touched ${agent.files.length} file${agent.files.length === 1 ? '' : 's'}: ${agent.files.map((f) => f.n).join(', ')}.`;
  }
  if (/task|doing|job|mission/.test(t)) {
    return `Current task: "${agent.task}" — ${Math.round(agent.pct)}% complete.`;
  }
  if (/pause|stop|hold/.test(t)) {
    return agent.paused
      ? "I'm paused — resume me from the Agents view when you're ready."
      : 'Still running. Pause me from the Agents view if you need me to hold.';
  }
  if (/\b(hi|hello|hey)\b/.test(t)) {
    return `${agent.name} here — ${Math.round(agent.pct)}% through "${agent.task}".`;
  }
  if (/thanks|thank you/.test(t)) {
    return 'On it.';
  }
  return `Noted: "${text.trim().slice(0, 60)}". Currently ${Math.round(agent.pct)}% through "${agent.task}".`;
}

export function localResponder(channel: ChatChannel, text: string, state: AetherState): string {
  return channel.kind === 'aether' ? aetherReply(text, state) : agentReply(channel, text, state);
}
