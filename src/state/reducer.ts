import type { AetherState, OpMode } from './types';
import { runCommand } from '../components/terminal/commands';
import { computeTick } from './tick';
import { nowShort } from '../utils/format';

export type Action =
  | { type: 'SET_ACTIVE_TAB'; tab: string }
  | { type: 'SET_CMD_VAL'; value: string }
  | { type: 'HIST_NAV'; up: boolean }
  | { type: 'TOGGLE_APPROVALS' }
  | { type: 'TOGGLE_NOTIFS' }
  | { type: 'RESOLVE_APPROVAL'; id: number; approve: boolean }
  | { type: 'SELECT_AGENT'; name: string }
  | { type: 'SET_OP_MODE'; mode: OpMode }
  | { type: 'RUN_COMMAND'; raw: string }
  | { type: 'NEW_PROJECT' }
  | { type: 'TICK' };

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

    case 'RESOLVE_APPROVAL': {
      const req = state.approvals.find((a) => a.id === action.id);
      if (!req) return state;
      const ok = action.approve;
      return {
        ...state,
        approvals: state.approvals.filter((a) => a.id !== action.id),
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
        rate: ok && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
      };
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
        projects: [{ name, status: 'QUEUED', pct: 0, hue: hues[state.projects.length % hues.length] }, ...state.projects],
      };
    }

    case 'TICK':
      return { ...state, ...computeTick(state) };

    default:
      return state;
  }
}
