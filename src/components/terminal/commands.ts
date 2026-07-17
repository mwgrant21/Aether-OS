import type { Agent, AetherState, CommandResult, TermLine, ThemeName, RendererMode } from '../../state/types';
import { fmt, fmtEta } from '../../utils/format';

const PROMPT = '#7fd8ef';
const BODY = '#9fc4d1';
const GOOD = '#3be0a0';
const BAD = '#ff9d9d';
const DIM = '#5f8a97';

function line(t: string, c: string = BODY): TermLine {
  return { t, c };
}

const AGENT_HUES = ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'];

export function makeAgent(name: string): Agent {
  return {
    i: name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    name,
    task: 'Initializing…',
    pct: 0,
    hue: AGENT_HUES[Math.floor(Math.random() * AGENT_HUES.length)],
    eta: 'calc…',
    share: 0.12 + Math.random() * 0.1,
    hist: [],
    files: [
      { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
      { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
    ],
  };
}

function nextAutoName(state: AetherState): string {
  const pool = ['Image Gen', 'Sentry', 'Doc Writer', 'Optimizer', 'Auditor'];
  const taken = new Set([...state.agents.map((a) => a.name), ...state.idleList.map((x) => x.name)]);
  return pool.find((n) => !taken.has(n)) || `Auxiliary ${state.agents.length + 1}`;
}

const THEME_NAMES: ThemeName[] = ['cyan', 'blue', 'teal', 'violet', 'amber', 'red'];

export function runCommand(state: AetherState, raw: string): CommandResult {
  const trimmed = raw.trim();
  const [cmd, ...args] = trimmed.split(/\s+/);
  const out: TermLine[] = [line(`operator@aether-core:~$ ${trimmed}`, PROMPT)];

  switch ((cmd || '').toLowerCase()) {
    case 'help': {
      out.push(
        line('Available commands:', DIM),
        line('  status              reactor & session summary'),
        line('  agents              list active agents'),
        line('  spawn <name>        spawn a new agent'),
        line('  kill <name>         terminate an agent'),
        line('  budget              token budget & burn'),
        line('  projects            list projects'),
        line('  sweep               run memory consolidation'),
        line('  approvals           list pending authorizations'),
        line('  approve <n>         grant request n'),
        line('  deny <n>            reject request n'),
        line('  theme <name>        cyan|blue|teal|violet|amber|red'),
        line('  renderer <mode>     nebula|volumetric|warp core renderer'),
        line('  clear               clear the terminal'),
      );
      return { kind: 'append', lines: out };
    }

    case 'status': {
      out.push(
        line(`◇ Reactor nominal — ${state.agents.length} agents drawing power`, GOOD),
        line(`  burn rate    ${fmt(state.rate)} tok/min`),
        line(`  session use  ${fmt(state.used)} tokens`),
        line(`  context      ${fmt(state.ctxUsed)} / 125,000`),
      );
      return { kind: 'append', lines: out };
    }

    case 'agents': {
      if (!state.agents.length) out.push(line('  no active agents', DIM));
      state.agents.forEach((a) =>
        out.push(line(`  ${a.i}  ${a.name.padEnd(16)}${Math.round(a.pct)}%  ${a.paused ? 'paused' : 'active'}`, a.paused ? '#f5c66b' : BODY)),
      );
      return { kind: 'append', lines: out };
    }

    case 'spawn': {
      const requested = args.join(' ');
      const agent = makeAgent(requested || nextAutoName(state));
      out.push(line(`✓ ${agent.name} spawned — reactor load increased`, GOOD));
      return {
        kind: 'append',
        lines: out,
        patch: { agents: [...state.agents, agent], rate: Math.min(168000, state.rate + 18000) },
      };
    }

    case 'kill': {
      const name = args.join(' ');
      const hit = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        out.push(line(`✗ no agent named "${name}"`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${hit.name} terminated — returned to idle pool`, GOOD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          agents: state.agents.filter((a) => a.name !== hit.name),
          idleList: [...state.idleList, { name: hit.name, last: 'just now' }],
        },
      };
    }

    case 'budget': {
      const rem = Math.max(0, state.cfg.capM * 1e6 - state.used);
      out.push(
        line(`  monthly cap  ${state.cfg.capM.toFixed(1)}M tokens`),
        line(`  used         ${fmt(state.used)} ($${(state.used * 0.000018).toFixed(2)})`),
        line(`  remaining    ${fmt(rem)} — depletes in ${fmtEta(rem / (state.rate / 60))}`),
      );
      return { kind: 'append', lines: out };
    }

    case 'projects': {
      if (!state.projects.length) out.push(line('  no projects tracked yet', DIM));
      state.projects.forEach((p) => out.push(line(`  ${p.status.padEnd(9)}${p.name} — ${p.pct}%`, p.status === 'BUILDING' ? PROMPT : BODY)));
      return { kind: 'append', lines: out };
    }

    case 'sweep': {
      const weak = state.memories.filter((m) => !m.pinned && m.strength <= 30).length;
      out.push(line(`✓ consolidation sweep complete — ${weak} weak engrams compacted`, GOOD));
      return { kind: 'append', lines: out, patch: { memories: state.memories.filter((m) => m.pinned || m.strength > 30) } };
    }

    case 'theme': {
      const theme = (args[0] || '').toLowerCase() as ThemeName;
      if (!THEME_NAMES.includes(theme)) {
        out.push(line('✗ unknown theme — try cyan|blue|teal|violet|amber|red', BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ reactor theme set to ${theme}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, theme } } };
    }

    case 'renderer': {
      const rd = (args[0] || '').toLowerCase();
      if (!['nebula', 'classic', 'volumetric', 'warp'].includes(rd)) {
        out.push(line('✗ usage: renderer nebula|volumetric|warp', BAD));
        return { kind: 'append', lines: out };
      }
      const key: RendererMode = rd === 'nebula' ? 'classic' : (rd as RendererMode);
      const suffix = rd === 'volumetric' ? ' — plasma shader online' : rd === 'warp' ? ' — intermix chamber aligned' : ' — containment field released';
      out.push(line(`✓ core renderer set to ${rd}${suffix}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, renderer: key } } };
    }

    case 'approvals': {
      if (!state.approvals.length) out.push(line('  queue clear', DIM));
      state.approvals.forEach((a, i) =>
        out.push(line(`  [${i + 1}] ${a.risk.padEnd(5)}${a.action} — ${a.agent}`, a.risk === 'HIGH' ? BAD : a.risk === 'MED' ? '#f5c66b' : BODY)),
      );
      return { kind: 'append', lines: out };
    }

    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const req = state.approvals[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!req) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      // Deviation from source: the original built this message via `cmd.toLowerCase() + 'd'`,
      // which produces "denyd" for the deny path. This port says "denied" correctly.
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${req.action}`, approve ? GOOD : BAD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          approvals: state.approvals.filter((a) => a.id !== req.id),
          rate: approve && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
        },
      };
    }

    case 'clear':
      return { kind: 'clear' };

    default:
      out.push(line(`✗ unknown command: ${cmd} — type 'help'`, BAD));
      return { kind: 'append', lines: out };
  }
}
