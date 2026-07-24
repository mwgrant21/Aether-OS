import type { Approval, AetherState, Cfg, DispatchChannelStub, MemoryStub, OpMode, RealUsageSnapshot } from './types';
import { detectCompletedDispatches, type RealAgentDispatch } from './liveAgentsMath';
import { makeAgent, runCommand } from '../components/terminal/commands';
import { computeTick } from './tick';
import { nowShort } from '../utils/format';
import { buildChatActionResultText } from './chatActionResult';

export type Action =
  | { type: 'SET_ACTIVE_TAB'; tab: string }
  | { type: 'TOGGLE_APPROVALS' }
  | { type: 'TOGGLE_NOTIFS' }
  | { type: 'RESOLVE_APPROVAL'; id: number; approve: boolean }
  | { type: 'ADD_APPROVAL'; approval: Omit<Approval, 'id'>; autoResolve?: boolean }
  | { type: 'CLEAR_CHAT_ACTION_RESULTS'; count: number }
  | { type: 'SELECT_AGENT'; name: string }
  | { type: 'SET_OP_MODE'; mode: OpMode }
  | { type: 'RUN_COMMAND'; raw: string }
  | { type: 'NEW_PROJECT' }
  | { type: 'TICK' }
  | { type: 'TOGGLE_AGENT_PAUSE'; name: string }
  | { type: 'REACTIVATE_AGENT'; name: string }
  | { type: 'SELECT_PROJECT'; name: string }
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number }
  | { type: 'UPDATE_CFG'; patch: Partial<Cfg> }
  | { type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }
  | { type: 'SET_ROUTE_DEFAULT'; value: string }
  | { type: 'SET_OPERATOR_NAME'; name: string }
  | { type: 'SET_REAL_USAGE'; snapshot: RealUsageSnapshot }
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }
  | { type: 'SELECT_REAL_AGENT'; toolUseId: string }
  | { type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string };

const THROTTLE_SHARE_CEILING = 0.08;

// Shared by RESOLVE_APPROVAL (existing, queued approval resolved later) and
// ADD_APPROVAL's autoResolve path (Phase 2b chat auto-approve, resolved in
// the same dispatch it's created in -- see ADD_APPROVAL below). Applying the
// verb-specific mutation, the HIGH-risk legacy shorthand, the
// chatActionResults emission, and the notif/log push all in one place means
// there is exactly one implementation of "what resolving an approval does",
// so the two callers can never drift out of sync with each other.
//
// `req` need not be present in `state.approvals` when this is called -- the
// `approvals.filter` below is a harmless no-op in that case (ADD_APPROVAL's
// autoResolve path never adds the approval to the queue in the first place).
function applyApprovalResolution(state: AetherState, req: Approval, approve: boolean): AetherState {
  const ok = approve;

  // Phase 2b: verb-specific execution, mirroring the identical AetherState
  // mutation Terminal's own spawn/kill would produce (or, for throttle, a
  // new minimal Agent.share cap) -- applied only on approval, and only for
  // approvals Phase 2b itself created (req.verb set). Every pre-existing
  // (seed + tick.ts) approval has no verb and is completely unaffected.
  let agents = state.agents;
  let idleList = state.idleList;
  let rate = state.rate;
  if (ok && req.verb === 'spawn' && req.targetAgentName) {
    agents = [...agents, makeAgent(req.targetAgentName)];
    rate = Math.min(168000, rate + 18000); // identical to Terminal's spawn
  } else if (ok && req.verb === 'kill' && req.targetAgentName) {
    const hit = agents.find((a) => a.name === req.targetAgentName);
    if (hit) {
      agents = agents.filter((a) => a.name !== hit.name);
      idleList = [...idleList, { name: hit.name, last: 'just now' }];
    }
    // no rate change -- identical to Terminal's kill
  } else if (ok && req.verb === 'throttle' && req.targetAgentName) {
    agents = agents.map((a) => (a.name === req.targetAgentName ? { ...a, share: Math.min(a.share, THROTTLE_SHARE_CEILING) } : a));
  } else if (ok && req.risk === 'HIGH') {
    // Pre-existing generic shorthand -- only applies to no-verb approvals,
    // since a verb-carrying approval's own specific mutation above (or
    // deliberate lack of one, for kill/throttle) is the real effect now;
    // applying both would double up or contradict it.
    rate = Math.min(168000, rate + 9000);
  }

  // A HIGH-risk request being resolved is notable regardless of outcome --
  // unlike the mutation branches above (which only ever apply on approve),
  // this fires on both approve and deny.
  let memories = state.memories;
  let memSeq = state.memSeq;
  if (req.risk === 'HIGH') {
    const memory: MemoryStub = {
      id: memSeq,
      name: `${ok ? 'Approved' : 'Denied'}: ${req.action}`,
      content: `${req.agent} — HIGH-risk request ${ok ? 'approved' : 'denied'}: ${req.action}`,
      source: req.agent,
      ts: nowShort(),
      pinned: false,
      strength: 100,
    };
    memories = [...memories, memory];
    memSeq += 1;
  }

  const chatActionResults = req.channelId
    ? [...state.chatActionResults, { channelId: req.channelId, text: buildChatActionResultText(req, ok) }]
    : state.chatActionResults;

  return {
    ...state,
    agents,
    idleList,
    rate,
    memories,
    memSeq,
    chatActionResults,
    approvals: state.approvals.filter((a) => a.id !== req.id),
    notifs: [
      { t: nowShort(), m: `${ok ? 'Approved: ' : 'Denied: '}${req.action} (${req.agent})`, c: ok ? '#3be0a0' : '#ff9d9d' },
      ...state.notifs,
    ].slice(0, 12),
    logs: [
      ...state.logs,
      {
        t: nowShort(),
        m: `${req.agent}: ${ok ? 'authorization granted — ' : 'request denied — '}${req.action.toLowerCase()}`,
        c: ok ? '#3be0a0' : '#ff9d9d',
      },
    ].slice(-14),
  };
}

export function reducer(state: AetherState, action: Action): AetherState {
  switch (action.type) {
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };

    case 'TOGGLE_APPROVALS':
      return { ...state, apprOpen: !state.apprOpen };

    case 'TOGGLE_NOTIFS':
      return { ...state, notifOpen: !state.notifOpen, unread: 0 };

    case 'SELECT_AGENT':
      return { ...state, selected: action.name };

    case 'SELECT_PROJECT':
      return { ...state, selectedProject: action.name };

    case 'SELECT_MEMORY':
      return { ...state, selectedMemory: String(action.id) };

    case 'TOGGLE_MEMORY_PIN':
      return {
        ...state,
        memories: state.memories.map((m) => (m.id === action.id ? { ...m, pinned: !m.pinned } : m)),
      };

    case 'SET_OP_MODE':
      return {
        ...state,
        cfg: { ...state.cfg, opMode: action.mode },
        notifs: [{ t: nowShort(), m: `Operating mode set to ${action.mode}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };

    case 'UPDATE_CFG':
      return { ...state, cfg: { ...state.cfg, ...action.patch } };

    case 'TOGGLE_PROVIDER_CONNECTION':
      return {
        ...state,
        providers: state.providers.map((p) => (p.name === action.name ? { ...p, connected: !p.connected } : p)),
      };

    case 'SET_ROUTE_DEFAULT':
      return { ...state, routeDefault: action.value };

    case 'SET_OPERATOR_NAME':
      return { ...state, operatorName: action.name };

    case 'SET_REAL_USAGE':
      return { ...state, realUsage: action.snapshot };

    case 'SET_REAL_AGENTS': {
      const completed = detectCompletedDispatches(state.realAgents, action.agents);
      let memories = state.memories;
      let memSeq = state.memSeq;
      let recentCompletedDispatches = state.recentCompletedDispatches;
      let dispatchChannels = state.dispatchChannels;
      for (const dispatch of completed) {
        const label = dispatch.description || dispatch.subagentType;
        memories = [
          ...memories,
          {
            id: memSeq,
            name: label,
            content: `${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}`,
            source: dispatch.subagentType,
            ts: nowShort(),
            pinned: false,
            strength: 100,
          },
        ];
        memSeq += 1;

        recentCompletedDispatches = [dispatch, ...recentCompletedDispatches].slice(0, 20);

        if (state.cfg.autoCreateDispatchChannels && !dispatchChannels.some((d) => d.toolUseId === dispatch.toolUseId)) {
          dispatchChannels = [
            ...dispatchChannels,
            {
              toolUseId: dispatch.toolUseId,
              subagentType: dispatch.subagentType,
              description: dispatch.description,
              prompt: dispatch.prompt,
              model: dispatch.model,
              startedAt: dispatch.startedAt,
              createdAt: nowShort(),
            },
          ];
        }
      }
      return { ...state, realAgents: action.agents, memories, memSeq, recentCompletedDispatches, dispatchChannels };
    }

    case 'CREATE_DISPATCH_CHANNEL': {
      const alreadyExists = state.dispatchChannels.some((d) => d.toolUseId === action.toolUseId);
      const dispatch = state.recentCompletedDispatches.find((d) => d.toolUseId === action.toolUseId);
      if (alreadyExists || !dispatch) return state;
      const stub: DispatchChannelStub = {
        toolUseId: dispatch.toolUseId,
        subagentType: dispatch.subagentType,
        description: dispatch.description,
        prompt: dispatch.prompt,
        model: dispatch.model,
        startedAt: dispatch.startedAt,
        createdAt: nowShort(),
      };
      return { ...state, dispatchChannels: [...state.dispatchChannels, stub] };
    }

    case 'REMOVE_DISPATCH_CHANNEL':
      return { ...state, dispatchChannels: state.dispatchChannels.filter((d) => d.toolUseId !== action.toolUseId) };

    case 'SELECT_REAL_AGENT':
      return { ...state, selectedRealAgent: action.toolUseId };

    case 'ADD_APPROVAL': {
      const newApproval: Approval = { ...action.approval, id: state.apprSeq };
      const bumped = { ...state, apprSeq: state.apprSeq + 1 };
      if (action.autoResolve) {
        // Atomic auto-approve: the approval is never added to state.approvals
        // at all (not even transiently) -- it goes straight into
        // applyApprovalResolution against `bumped`, so there is no window
        // between "id assigned" and "resolved" for a concurrent dispatch
        // (e.g. tick.ts's own apprSeq-bumping approval generation) to shift
        // apprSeq and cause a caller-predicted id to resolve the wrong
        // approval. See useChatChannels.ts's risky-verb path, which used to
        // predict this id across two dispatches -- that race is why this
        // exists.
        return applyApprovalResolution(bumped, newApproval, true);
      }
      return { ...bumped, approvals: [...state.approvals, newApproval] };
    }

    case 'CLEAR_CHAT_ACTION_RESULTS':
      return { ...state, chatActionResults: state.chatActionResults.slice(action.count) };

    case 'RESOLVE_APPROVAL': {
      const req = state.approvals.find((a) => a.id === action.id);
      if (!req) return state;
      return applyApprovalResolution(state, req, action.approve);
    }

    case 'RUN_COMMAND': {
      const result = runCommand(state, action.raw);
      const base = result.patch ? { ...state, ...result.patch } : state;
      return {
        ...base,
        cmdHist: [...base.cmdHist, action.raw].slice(-30),
        commandsRun: base.commandsRun + 1,
      };
    }

    case 'NEW_PROJECT': {
      const pool = ['Support Portal', 'Internal Tools', 'Marketing Site'];
      const taken = new Set(state.projects.map((p) => p.name));
      const name = pool.find((n) => !taken.has(n)) ?? `Project ${state.projects.length + 1}`;
      const hues = ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'];
      return {
        ...state,
        projects: [{ name, status: 'QUEUED', pct: 0, hue: hues[state.projects.length % hues.length], crew: [] }, ...state.projects],
      };
    }

    case 'TICK':
      return { ...state, ...computeTick(state) };

    case 'TOGGLE_AGENT_PAUSE':
      return {
        ...state,
        agents: state.agents.map((a) => (a.name === action.name ? { ...a, paused: !a.paused } : a)),
      };

    case 'REACTIVATE_AGENT': {
      const hit = state.idleList.find((i) => i.name === action.name);
      if (!hit) return state;
      return {
        ...state,
        idleList: state.idleList.filter((i) => i.name !== action.name),
        agents: [...state.agents, makeAgent(hit.name)],
        selected: hit.name,
        rate: Math.min(168000, state.rate + 18000),
      };
    }

    default:
      return state;
  }
}
