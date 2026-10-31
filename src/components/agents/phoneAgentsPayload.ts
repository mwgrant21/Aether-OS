// Builds the phone `agents` view roster payload (privacy section 17) in the renderer, from the same grouping the Agent
// Roster card draws (groupDispatches). `fleet` and `timeline` are main-fed and not part of this payload. Free text is
// the dispatch description, headline, narration, anomaly detail and the dispatch PROMPT. Each is masked on the raw text
// FIRST and only then cut (never lower-cased or otherwise normalised before masking, so case-sensitive rules such as
// AKIA... and eyJ... still fire); main masks and caps again in encodeAgentsView. Never sent: toolUseId beyond the
// opaque id string, permission or flag requests, Verify-with-Codex.
import type { AetherState } from '../../state/types';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import { maskSecrets } from '../../shared/board/text';
import { applyNarrationVerbosity } from '../../shared/narrationVerbosity';
import { groupDispatches } from './rosterGrouping';

export const AGENTS_RUNNING_CAP = 30;
export const AGENTS_DONE_CAP = 20;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const goodNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const clip = (s: unknown, n: number): string => {
  if (typeof s !== 'string') return '';
  const t = maskSecrets(s);
  return t.length > n ? t.slice(0, n) : t;
};
const startMs = (a: RealAgentDispatch): number => new Date(a.startedAt).getTime();
const usable = (a: RealAgentDispatch): boolean => ID_RE.test(a.toolUseId) && Number.isFinite(startMs(a));

/**
 * nowMs is the publish instant, sent as computedAtMs. A dispatch whose id is not an opaque safe string or whose start
 * time is unparseable is dropped on its own instead of nulling the payload; a non-finite usage number becomes null.
 * Running is NEEDS INPUT first, then WORKING, cut at 30; needsInput is exactly "an anomaly exists for this dispatch"
 * (the groupDispatches rule). Done is the groupDispatches DONE list, cut at 20.
 */
export function phoneAgentsPayload(state: AetherState, nowMs: number): Record<string, unknown> {
  const [needs, working, done] = groupDispatches(state.realAgents, state.anomalies, state.recentCompletedDispatches);
  const anomalyOf = new Map<string, { kind: string; detail: string }>();
  for (const a of state.anomalies) if (!anomalyOf.has(a.toolUseId)) anomalyOf.set(a.toolUseId, a);

  const running = [...needs.dispatches, ...working.dispatches].filter(usable).slice(0, AGENTS_RUNNING_CAP).map((d) => {
    const an = anomalyOf.get(d.toolUseId) ?? null;
    const raw = state.dispatchNarrations[d.toolUseId];
    const narration = raw ? applyNarrationVerbosity(raw.narration, state.cfg.narrationVerbosity, raw.severity as 0 | 1 | 2 | 3 | 4) : null;
    return {
      id: d.toolUseId,
      type: d.subagentType,
      description: clip(d.description, 120),
      startedAtMs: startMs(d),
      model: typeof d.model === 'string' ? clip(d.model, 40) : null,
      headline: clip(state.dispatchHeadlines[d.toolUseId] ?? d.description, 120),
      narration: narration === null ? null : clip(narration, 160),
      needsInput: an !== null,
      anomaly: an === null ? null : { kind: an.kind, detail: clip(an.detail, 1000) },
      prompt: clip(d.prompt, 1200),
    };
  });
  const doneRows = done.dispatches.filter(usable).slice(0, AGENTS_DONE_CAP).map((d) => {
    const u = state.dispatchUsage[d.toolUseId];
    return {
      id: d.toolUseId,
      type: d.subagentType,
      description: clip(d.description, 120),
      startedAtMs: startMs(d),
      tokens: goodNum(u?.tokens) ? u.tokens : null,
      toolUses: goodNum(u?.toolUses) ? u.toolUses : null,
      durationMs: goodNum(u?.durationMs) ? u.durationMs : null,
      headline: clip(state.dispatchHeadlines[d.toolUseId] ?? d.description, 120),
    };
  });
  return { computedAtMs: nowMs, running, done: doneRows };
}
