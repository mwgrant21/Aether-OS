import type { Agent, AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { resolvePersona } from './personas';
import { resolveOperatorName } from '../../utils/format';

function referAsInstruction(operatorName: string): string {
  return `You refer to the user as "${resolveOperatorName(operatorName)}."`;
}

function aetherVoice(operatorName: string): string {
  return (
    'You are AETHER, the mission-control intelligence of this dashboard. ' +
    'Dry, precise, and economical with words. ' +
    referAsInstruction(operatorName)
  );
}

// AETHER "knows everything" -- a full fleet snapshot.
export interface AetherSnapshot {
  burnRateTokPerMin: number;
  budget: { usedTokens: number; capTokens: number };
  alarmLevel: AetherState['alarmLevel'];
  agents: { name: string; role: string; status: 'active' | 'paused'; tokenDraw: number }[];
  projects: { name: string; status: string; crew: string[] }[];
  pendingApprovals: { agent: string; action: string; risk: string }[];
  recentEvents: { time: string; message: string }[];
}

export function buildAetherSnapshot(state: AetherState): AetherSnapshot {
  return {
    burnRateTokPerMin: Math.round(state.rate),
    budget: { usedTokens: Math.round(state.used), capTokens: Math.round(state.cfg.capM * 1e6) },
    alarmLevel: state.alarmLevel,
    // `role` has no dedicated field on Agent -- `task` (the dynamic mission
    // description) is the closest stable stand-in this data model offers.
    agents: state.agents.map((a) => ({
      name: a.name,
      role: a.task,
      status: a.paused ? ('paused' as const) : ('active' as const),
      tokenDraw: Math.round(a.share * state.rate),
    })),
    projects: state.projects.map((p) => ({ name: p.name, status: p.status, crew: p.crew })),
    pendingApprovals: state.approvals.map((a) => ({ agent: a.agent, action: a.action, risk: a.risk })),
    recentEvents: state.logs.slice(-5).map((l) => ({ time: l.t, message: l.m })),
  };
}

// Agents "only know their own work in detail" -- deliberately narrower than
// buildAetherSnapshot: no roster, no approvals, no projects. Just this
// agent's own work plus a light-touch fleet summary.
export interface AgentSnapshot {
  self: { name: string; task: string; pctComplete: number; eta: string; paused: boolean; filesTouched: string[] };
  fleet: { activeAgentCount: number; burnRateTokPerMin: number; alarmLevel: AetherState['alarmLevel'] };
}

export function buildAgentSnapshot(state: AetherState, agent: Agent): AgentSnapshot {
  return {
    self: {
      name: agent.name,
      task: agent.task,
      pctComplete: Math.round(agent.pct),
      eta: agent.eta,
      paused: !!agent.paused,
      filesTouched: agent.files.map((f) => f.n),
    },
    fleet: {
      activeAgentCount: state.agents.length,
      burnRateTokPerMin: Math.round(state.rate),
      alarmLevel: state.alarmLevel,
    },
  };
}

// The action-JSON-on-last-line convention (verb in spawn|kill|theme|renderer|
// throttle) is mentioned here now, even though nothing parses it yet --
// Phase 2b (a separate future plan) adds the parser/executor as a pure
// addition with NO further system-prompt rewrite. This was a real decision
// point: the alternative was deferring this sentence to 2b entirely. Mention-
// now was chosen because it's harmless (unparsed JSON in a chat reply is
// just inert text today) and avoids a second prompt-behavior-changing plan.
//
// Deliberately does not spell out the word "markdown" -- naming the format by
// name in an instruction telling the model NOT to use it is a known priming
// pitfall (it can nudge some models toward the very formatting being
// forbidden). Naming the concrete elements to avoid achieves the same intent
// without that risk.
//
// The per-verb args shapes were added after live-model QA (funded credits,
// 2026-07-19): the original prompt said only `"args": {...}}`, and the real
// model reasonably inferred `{"color":"violet"}` for a theme change instead
// of the `actionExecutor.ts`-required `{"name":"violet"}` -- parseActionLine
// still stripped the (wrong-shaped) JSON cleanly, but buildSafeCommandRaw
// silently no-op'd since `args.name` was absent, so the theme never actually
// changed despite a plausible-looking, in-character confirmation reply. This
// was a genuine prompt/executor contract gap, not a one-off model quirk --
// any model would have to guess at an unspecified schema. Naming every key
// verbatim closes it at the source.
const RULES =
  'Reply in at most 3 sentences. Stay in character. Reply in plain prose only -- no bold, italics, ' +
  'headers, bullet lists, or code fences. ' +
  'If your reply implies a concrete action you could take (spawn, kill, theme, renderer, throttle), ' +
  'you may end your reply with one extra line containing a compact JSON object using EXACTLY one of ' +
  'these shapes -- the args key names matter and must be used verbatim, not a synonym: ' +
  '{"verb":"theme","args":{"name":"cyan|blue|teal|violet|amber|red"}}, ' +
  '{"verb":"renderer","args":{"mode":"nebula|volumetric|warp"}}, or ' +
  '{"verb":"spawn|kill|throttle","args":{"name":"<agent name>"}}. This is optional and only ' +
  'meaningful for actions in your own domain -- omit it for ordinary conversational replies.';

// Composes Persona + live-state snapshot (JSON) + Rules into the exact
// system-prompt string passed to askClaude. Replaces Phase 1's one-line
// placeholder in useChatChannels.ts (see Task 3).
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${aetherVoice(state.operatorName)}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  const persona = resolvePersona(channel.name);
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    // Archived channels never reach askClaude in practice (useChatChannels
    // blocks sending when channel.archived is true), but build a safe
    // prompt anyway rather than assume every future caller guards this.
    return `You are ${channel.name}. ${persona.voice} ${referAsInstruction(state.operatorName)}\n\nYou are currently offline/archived.\n\n${RULES}`;
  }

  const snapshot = buildAgentSnapshot(state, agent);
  return `You are ${channel.name}. ${persona.voice} ${referAsInstruction(state.operatorName)}\n\nYour current state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
}
