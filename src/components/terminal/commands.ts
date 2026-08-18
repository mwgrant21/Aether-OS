import type { AetherState, CommandResult, TermLine, ThemeName, RendererMode } from '../../state/types';
import { fmt, fmtEta, fmtElapsed } from '../../utils/format';
import { deriveContextWindowCard } from '../layout/contextWindowCard';

/**
 * Real context-window figures from the statusline payload. Previously this
 * line rendered a real token count against a hardcoded `/ 125,000` while the
 * machine's actual window was 200,000 -- see issue #20.
 *
 * Carries the staleness marker through. The statusline file can hold a
 * snapshot from a previous run -- 14 days old on the dev machine -- and a
 * days-old token count printed bare reads as a live measurement. Uses the
 * same `~` prefix and `stale` wording the footer's CONTEXT WINDOW card uses,
 * so one feed is not described two different ways.
 */
function formatContextLine(state: AetherState): string {
  const ctx = deriveContextWindowCard(state.statusline);
  if (!ctx.available) return 'no reading yet';
  const used = fmt(ctx.usedTokens as number);
  const figure = ctx.windowSize === null ? used : `${used} / ${fmt(ctx.windowSize)}`;
  return ctx.stale ? `~${figure} · stale` : figure;
}

const PROMPT = '#7fd8ef';
const BODY = '#9fc4d1';
const GOOD = '#3be0a0';
const BAD = '#ff9d9d';
const DIM = '#5f8a97';

function line(t: string, c: string = BODY): TermLine {
  return { t, c };
}

export const THEME_NAMES: ThemeName[] = ['cyan', 'blue', 'teal', 'violet', 'amber', 'red'];
export const RENDERER_WORDS = ['nebula', 'volumetric', 'warp', 'storm'] as const;

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
        line('  budget              token budget & burn'),
        line('  projects            list projects'),
        line('  approvals           list pending authorizations'),
        line('  approve <n>         grant request n'),
        line('  deny <n>            reject request n'),
        line('  theme <name>        cyan|blue|teal|violet|amber|red'),
        line('  renderer <mode>     nebula|volumetric|warp|storm core renderer'),
        line('  thememode <dark|light>  switch light/dark palette'),
      );
      return { kind: 'append', lines: out };
    }

    case 'status': {
      out.push(
        line(`◇ Reactor nominal — ${state.realAgents.length} agents drawing power`, GOOD),
        line(`  burn rate    ${fmt(state.rate)} tok/min`),
        line(`  session use  ${fmt(state.used)} tokens`),
        line(`  context      ${formatContextLine(state)}`),
      );
      return { kind: 'append', lines: out };
    }

    case 'agents': {
      if (!state.realAgents.length) out.push(line('  no active agents', DIM));
      state.realAgents.forEach((a) =>
        out.push(line(`  ${a.subagentType.padEnd(20)}${fmtElapsed(Date.now() - new Date(a.startedAt).getTime())}  ${a.description}`)),
      );
      return { kind: 'append', lines: out };
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
      const roots = state.projectsSnapshot?.roots ?? [];
      if (!roots.length) out.push(line('  no projects tracked yet', DIM));
      roots.forEach((p) => out.push(line(`  $${p.ledger.total.usd.toFixed(2).padEnd(9)}${p.name}`, PROMPT)));
      return { kind: 'append', lines: out };
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
      if (!(RENDERER_WORDS as readonly string[]).includes(rd)) {
        out.push(line('✗ usage: renderer nebula|volumetric|warp|storm', BAD));
        return { kind: 'append', lines: out };
      }
      const key: RendererMode = rd === 'nebula' ? 'classic' : (rd as RendererMode);
      const suffix =
        rd === 'volumetric'
          ? ' — plasma shader online'
          : rd === 'warp'
            ? ' — intermix chamber aligned'
            : rd === 'storm'
              ? ' — discharge grid live'
              : ' — containment field released';
      out.push(line(`✓ core renderer set to ${rd}${suffix}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, renderer: key } } };
    }

    case 'thememode': {
      const mode = (args[0] || '').toLowerCase();
      if (mode !== 'dark' && mode !== 'light') {
        out.push(line('✗ usage: thememode dark|light', BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ theme mode set to ${mode}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, themeMode: mode } } };
    }

    case 'approvals': {
      type PendingEntry = { kind: 'permission'; req: NonNullable<AetherState['pendingPermissionRequest']> } | { kind: 'flag'; req: NonNullable<AetherState['pendingPostToolFlag']> };
      const pending: PendingEntry[] = [
        state.pendingPermissionRequest ? { kind: 'permission', req: state.pendingPermissionRequest } : null,
        state.pendingPostToolFlag ? { kind: 'flag', req: state.pendingPostToolFlag } : null,
      ].filter((x): x is PendingEntry => x !== null);
      if (!pending.length) out.push(line('  queue clear', DIM));
      pending.forEach((p, i) => {
        const risk = p.kind === 'permission' ? p.req.risk : null;
        // Same 3-way scheme TopBar's riskBadgeStyle uses (danger/warn/success);
        // a post-tool flag has no risk at all and renders as the amber REVIEW.
        const riskColor = risk === 'HIGH' ? BAD : risk === 'LOW' ? GOOD : '#f5c66b';
        out.push(line(`  [${i + 1}] ${(risk ?? 'REVIEW').padEnd(5)}${p.req.toolName} — ${p.kind === 'permission' ? 'permission request' : 'post-tool flag'}`, riskColor));
      });
      return { kind: 'append', lines: out };
    }

    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const pending = [
        state.pendingPermissionRequest && { kind: 'permission' as const, req: state.pendingPermissionRequest },
        state.pendingPostToolFlag && { kind: 'flag' as const, req: state.pendingPostToolFlag },
      ].filter((x): x is { kind: 'permission' | 'flag'; req: any } => Boolean(x));
      const target = pending[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!target) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${target.req.toolName}`, approve ? GOOD : BAD));
      if (target.kind === 'permission') {
        window.aetherElectron?.permission.respond(
          target.req.requestId,
          approve ? { behavior: 'allow', updatedInput: target.req.toolInput } : { behavior: 'deny', reason: 'denied via Terminal' }
        );
      } else {
        window.aetherElectron?.postToolFlag.respond(
          target.req.requestId,
          approve ? { block: false } : { block: true, reason: 'denied via Terminal' }
        );
      }
      return { kind: 'append', lines: out };
    }

    default:
      out.push(line(`✗ unknown command: ${cmd} — type 'help'`, BAD));
      return { kind: 'append', lines: out };
  }
}
