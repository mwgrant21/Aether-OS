import type { Approval, AetherState, OpMode } from './types';
import { makeAgent, runCommand } from '../components/terminal/commands';
import { computeTick } from './tick';
import { nowShort } from '../utils/format';
import { buildChatActionResultText } from './chatActionResult';

export type Action =
  | { type: 'SET_ACTIVE_TAB'; tab: string }
  | { type: 'SET_CMD_VAL'; value: string }
  | { type: 'HIST_NAV'; up: boolean }
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
  | { type: 'REACTIVATE_AGENT'; name: string };

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

  const chatActionResults = req.channelId
    ? [...state.chatActionResults, { channelId: req.channelId, text: buildChatActionResultText(req, ok) }]
    : state.chatActionResults;

  return {
    ...state,
    agents,
    idleList,
    rate,
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

    case 'SET_CMD_VAL':
      return { ...state, cmdVal: action.value };

    case 'HIST_NAV': {
      const h = state.cmdHist;
      if (!h.length) return state;
      let i: number;
      if (action.up) i = state.histIdx < 0 ? h.length - 1 : Math.max(0, state.histIdx - 1);
      else {
        i = state.histIdx < 0 ? -1 : state.histIdx + 1;
        if (i >= h.length) i = -1;
      }
      return { ...state, histIdx: i, cmdVal: i < 0 ? '' : h[i] };
    }

    case 'TOGGLE_APPROVALS':
      return { ...state, apprOpen: !state.apprOpen };

    case 'TOGGLE_NOTIFS':
      return { ...state, notifOpen: !state.notifOpen, unread: 0 };

    case 'SELECT_AGENT':
      return { ...state, selected: action.name };

    case 'SET_OP_MODE':
      return {
        ...state,
        cfg: { ...state.cfg, opMode: action.mode },
        notifs: [{ t: nowShort(), m: `Operating mode set to ${action.mode}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };

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
      if (result.kind === 'clear') {
        return { ...state, termHist: [], cmdVal: '' };
      }
      const base = result.patch ? { ...state, ...result.patch } : state;
      return {
        ...base,
        termHist: [...base.termHist, ...result.lines].slice(-60),
        cmdVal: '',
        cmdHist: [...base.cmdHist, action.raw].slice(-30),
        histIdx: -1,
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
