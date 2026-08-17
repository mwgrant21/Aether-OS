import type { AetherState, Cfg, DispatchChannelStub, FleetSessionRow, MemoryRow, MemoryTombstone, OpMode, PermissionRequestUI, PostToolFlagRequestUI, RealUsageSnapshot, RecapPayload } from './types';
import type { NotificationReason } from '../shared/alertSounds';
import type { DiagnosticsSnapshot } from '../../electron/collectorStore';
import type { LedgerSnapshot } from '../shared/ledgerMath';
import type { ProjectsSnapshot } from '../shared/projectsSnapshot';
import type { StatuslineSnapshot } from '../shared/statuslinePayload';
import { detectCompletedDispatches, detectStartedDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type RealActiveWork } from './liveAgentsMath';
import { makeAgent, runCommand } from '../components/terminal/commands';
import { computeTick } from './tick';
import { nowShort, nowLong, short, fmtElapsed } from '../utils/format';
import { computeMomentum, computeRateFromUsage } from '../components/reactor/reactorMath';
import type { Anomaly } from '../shared/anomalyDetectors';
import type { OptimizeFinding, OptimizeSummary } from '../shared/optimizeRules';
import type { GradeRow } from '../shared/optimizeGrade';
import { narrationForEvent, rankForInterruption, appendNarrationMessage, type NarrationEvent } from '../components/comms/narrationFeed';

export type Action =
  | { type: 'SET_ACTIVE_TAB'; tab: string }
  | { type: 'TOGGLE_APPROVALS' }
  | { type: 'TOGGLE_NOTIFS' }
  | { type: 'SELECT_AGENT'; name: string }
  | { type: 'SET_OP_MODE'; mode: OpMode }
  | { type: 'RUN_COMMAND'; raw: string }
  | { type: 'TICK' }
  | { type: 'TOGGLE_AGENT_PAUSE'; name: string }
  | { type: 'REACTIVATE_AGENT'; name: string }
  | { type: 'SELECT_PROJECT'; key: string | null }
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'SET_MEMORIES'; memories: MemoryRow[] }
  | { type: 'SET_MEMORY_TOMBSTONES'; tombstones: MemoryTombstone[] }
  | { type: 'SET_MEMORY_SCOPE_FILTER'; filter: string }
  | { type: 'TOGGLE_MEMORY_TOMBSTONE_VIEW' }
  | { type: 'UPDATE_CFG'; patch: Partial<Cfg> }
  | { type: 'SET_TERMINAL_ALIVE'; alive: boolean }
  | { type: 'SET_CODEX_TERMINAL_ALIVE'; alive: boolean }
  | { type: 'SET_TERMINAL_IDLE'; idle: boolean }
  | { type: 'SET_CODEX_TERMINAL_IDLE'; idle: boolean }
  | { type: 'SET_OPERATOR_NAME'; name: string }
  | { type: 'SET_REAL_USAGE'; snapshot: RealUsageSnapshot }
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }
  | { type: 'SELECT_REAL_AGENT'; toolUseId: string }
  | { type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'RECORD_DISPATCH_USAGE'; completed: CompletedDispatchUsage[] }
  | { type: 'SET_ACTIVE_WORK'; work: RealActiveWork[] }
  | { type: 'SET_ANOMALIES'; anomalies: Anomaly[] }
  | { type: 'SET_CACHE_HIT_RATIO'; ratio: number }
  | { type: 'SET_FLEET'; fleet: FleetSessionRow[] | null }
  | { type: 'SET_DIAGNOSTICS'; diagnostics: DiagnosticsSnapshot | null }
  | { type: 'SET_LEDGER'; ledger: LedgerSnapshot | null }
  | { type: 'SET_PROJECTS_SNAPSHOT'; snapshot: ProjectsSnapshot | null }
  | { type: 'SET_PENDING_PERMISSION_REQUEST'; request: PermissionRequestUI | null }
  | { type: 'SET_PENDING_POST_TOOL_FLAG'; request: PostToolFlagRequestUI | null }
  | { type: 'SET_OPTIMIZE_FINDINGS'; findings: OptimizeFinding[] }
  | { type: 'SET_OPTIMIZE_SUMMARY'; summary: OptimizeSummary }
  | { type: 'SET_OPTIMIZE_BREAKDOWN'; rows: GradeRow[] }
  | { type: 'SET_STATUSLINE'; snapshot: StatuslineSnapshot | null }
  | { type: 'SET_LAST_NOTIFICATION'; reason: NotificationReason }
  | { type: 'RECAP_RECEIVED'; recap: RecapPayload }
  | { type: 'DISMISS_RECAP' }
  | { type: 'SET_DISPATCH_HEADLINE'; toolUseId: string; headline: string }
  | { type: 'SET_DISPATCH_NARRATION'; toolUseId: string; narration: string; severity: number }
  | { type: 'SET_CROSS_ENGINE_CFG'; cfg: { enabled: boolean; provider: 'codex-chatgpt' } }
  | { type: 'SET_CODEX_TERMINAL_CFG'; cfg: { enabled: boolean } };

// Shared by every reducer case that can produce a narration line (Stage 14
// Task 5): builds the message via narrationForEvent, ranks it against its
// channel's interruption budget, and returns the updated maps. No-op
// (returns the inputs unchanged) when narrationForEvent declines to speak.
function applyNarrationEvent(
  event: NarrationEvent,
  eventState: AetherState,
  narrationMessages: AetherState['narrationMessages'],
  narrationBudgets: AetherState['narrationBudgets']
): { narrationMessages: AetherState['narrationMessages']; narrationBudgets: AetherState['narrationBudgets'] } {
  const message = narrationForEvent(event, eventState);
  if (!message) return { narrationMessages, narrationBudgets };
  const ranked = rankForInterruption(message, narrationBudgets, Date.now());
  const finalMessage = { ...message, interrupts: ranked.interrupts };
  return { narrationMessages: appendNarrationMessage(narrationMessages, finalMessage), narrationBudgets: ranked.budgets };
}

// NotificationReason is an open union ('agent_needs_input' | 'agent_completed'
// | 'permission_prompt' | string -- see shared/alertSounds.ts), so this maps
// the named reasons to display copy and humanises anything the hook sends that
// we don't have a label for, rather than leaking a raw snake_case enum value
// into the notification bell.
const NOTIFICATION_REASON_LABELS: Record<string, string> = {
  agent_needs_input: 'Agent needs input',
  agent_completed: 'Agent completed',
  permission_prompt: 'Permission requested',
};

function notificationReasonLabel(reason: NotificationReason): string {
  const known = NOTIFICATION_REASON_LABELS[reason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Notification';
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
      return { ...state, selectedProject: action.key };

    case 'SELECT_MEMORY':
      return { ...state, selectedMemory: String(action.id) };

    case 'SET_MEMORIES':
      return { ...state, memories: action.memories };

    case 'SET_MEMORY_TOMBSTONES':
      return { ...state, memoryTombstones: action.tombstones };

    case 'SET_MEMORY_SCOPE_FILTER':
      return { ...state, memoryScopeFilter: action.filter };

    case 'TOGGLE_MEMORY_TOMBSTONE_VIEW':
      return { ...state, memoryShowTombstones: !state.memoryShowTombstones };

    case 'SET_CROSS_ENGINE_CFG':
      return { ...state, crossEngineCfg: action.cfg };

    case 'SET_CODEX_TERMINAL_CFG':
      return { ...state, codexTerminalCfg: action.cfg };

    case 'SET_OP_MODE':
      return {
        ...state,
        cfg: { ...state.cfg, opMode: action.mode },
        notifs: [{ t: nowShort(), m: `Operating mode set to ${action.mode}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };

    case 'UPDATE_CFG':
      return { ...state, cfg: { ...state.cfg, ...action.patch } };

    case 'SET_TERMINAL_ALIVE':
      return { ...state, terminalAlive: action.alive };

    case 'SET_CODEX_TERMINAL_ALIVE':
      return { ...state, codexTerminalAlive: action.alive };

    case 'SET_TERMINAL_IDLE':
      return state.terminalIdle === action.idle ? state : { ...state, terminalIdle: action.idle };

    case 'SET_CODEX_TERMINAL_IDLE':
      return state.codexTerminalIdle === action.idle ? state : { ...state, codexTerminalIdle: action.idle };

    case 'SET_OPERATOR_NAME':
      return { ...state, operatorName: action.name };

    case 'SET_REAL_USAGE': {
      const rateHistory = state.rateHistory.concat({ burnRatePerMin: action.snapshot.burnRatePerMin, atMs: Date.now() }).slice(-3);
      return {
        ...state,
        realUsage: action.snapshot,
        ctxUsed: action.snapshot.ctxUsed,
        rateHistory,
        momentum: computeMomentum(rateHistory),
        rate: computeRateFromUsage(action.snapshot.burnRatePerMin),
      };
    }

    case 'SET_REAL_AGENTS': {
      const completed = detectCompletedDispatches(state.realAgents, action.agents);
      const started = detectStartedDispatches(state.realAgents, action.agents);
      let recentCompletedDispatches = state.recentCompletedDispatches;
      let dispatchChannels = state.dispatchChannels;
      let logs = state.logs;

      for (const dispatch of started) {
        logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: ${dispatch.description || 'dispatch started'}`, c: '#7fd8ef' }).slice(-14);
      }

      for (const dispatch of completed) {
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
          logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
        }
      }
      return { ...state, realAgents: action.agents, recentCompletedDispatches, dispatchChannels, logs };
    }

    case 'SET_ACTIVE_WORK':
      return { ...state, activeWork: action.work };

    case 'SET_ANOMALIES': {
      const prevIds = new Set(state.anomalies.map((a) => `${a.toolUseId}:${a.kind}`));
      const newAnomalies = action.anomalies.filter((a) => !prevIds.has(`${a.toolUseId}:${a.kind}`));
      const eventState = { ...state, anomalies: action.anomalies };
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      for (const anomaly of newAnomalies) {
        const applied = applyNarrationEvent(
          { kind: 'anomalyDetected', toolUseId: anomaly.toolUseId, anomalyKind: anomaly.kind },
          eventState,
          narrationMessages,
          narrationBudgets
        );
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
      }
      // Deliberately no bell notif here. Every Anomaly carries a toolUseId, and
      // main.ts's onPostToolUse raises a post-tool flag review off that same
      // detector trip -- so pushing one here too would make a single detection
      // produce two (or three, counting the flag's resolve) bell entries, which
      // is exactly the notification noise this feature exists to remove.
      // Anomalies stay visible via narration, AgentRosterCard, GridView and the
      // reactor's anomaly flicker; the actionable one arrives as
      // SET_PENDING_POST_TOOL_FLAG's "Flagged for review" notif.
      //
      // Every anomaly-set change is a chance STEWARD's all_clear condition
      // now holds (e.g. the last anomaly just cleared) -- stewardStateCheck
      // no-ops unless it actually does.
      const cleared = applyNarrationEvent({ kind: 'stewardStateCheck' }, eventState, narrationMessages, narrationBudgets);
      narrationMessages = cleared.narrationMessages;
      narrationBudgets = cleared.narrationBudgets;
      return { ...state, anomalies: action.anomalies, narrationMessages, narrationBudgets };
    }

    case 'SET_CACHE_HIT_RATIO':
      return { ...state, cacheHitRatio: action.ratio };

    case 'SET_FLEET':
      return { ...state, fleet: action.fleet };

    case 'SET_DIAGNOSTICS':
      return { ...state, diagnostics: action.diagnostics };

    case 'SET_LEDGER':
      return { ...state, ledger: action.ledger };

    case 'SET_PROJECTS_SNAPSHOT':
      return { ...state, projectsSnapshot: action.snapshot };

    case 'SET_PENDING_PERMISSION_REQUEST': {
      const eventState = { ...state, pendingPermissionRequest: action.request };
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      let notifs = state.notifs;
      let unread = state.unread;
      if (action.request && !state.pendingPermissionRequest) {
        const applied = applyNarrationEvent({ kind: 'permissionPending' }, eventState, narrationMessages, narrationBudgets);
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Permission requested: ${action.request.toolName} (${action.request.risk})`, c: '#f5c66b' }, ...notifs].slice(0, 12);
        unread += 1;
      } else if (!action.request && state.pendingPermissionRequest) {
        const applied = applyNarrationEvent({ kind: 'stewardStateCheck' }, eventState, narrationMessages, narrationBudgets);
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Permission request resolved: ${state.pendingPermissionRequest.toolName}`, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      return { ...state, pendingPermissionRequest: action.request, narrationMessages, narrationBudgets, notifs, unread };
    }

    case 'SET_PENDING_POST_TOOL_FLAG': {
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      let notifs = state.notifs;
      let unread = state.unread;
      if (action.request && !state.pendingPostToolFlag) {
        const eventState = { ...state, pendingPostToolFlag: action.request };
        const applied = applyNarrationEvent(
          { kind: 'postToolFlag', anomalyKind: action.request.anomalyKind },
          eventState,
          narrationMessages,
          narrationBudgets
        );
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
        notifs = [{ t: nowShort(), m: `Flagged for review: ${action.request.toolName} (${action.request.anomalyKind})`, c: '#f5c66b' }, ...notifs].slice(0, 12);
        unread += 1;
      } else if (!action.request && state.pendingPostToolFlag) {
        notifs = [{ t: nowShort(), m: `Flag review resolved: ${state.pendingPostToolFlag.toolName}`, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      return { ...state, pendingPostToolFlag: action.request, narrationMessages, narrationBudgets, notifs, unread };
    }

    case 'SET_OPTIMIZE_FINDINGS':
      return { ...state, optimizeFindings: action.findings };

    case 'SET_OPTIMIZE_SUMMARY':
      return { ...state, optimizeSummary: action.summary };

    case 'SET_OPTIMIZE_BREAKDOWN':
      return { ...state, optimizeBreakdown: action.rows };

    case 'SET_STATUSLINE':
      return { ...state, statusline: action.snapshot };

    case 'SET_LAST_NOTIFICATION': {
      const lastNotification = { reason: action.reason, atMs: Date.now() };
      // 'permission_prompt' is the one reason that is always accompanied by a
      // SET_PENDING_PERMISSION_REQUEST arrival ("Permission requested: X"),
      // which says the same thing with the tool name attached -- so only
      // lastNotification (used for the sound cue) updates here, no second bell
      // entry for the same event.
      if (action.reason === 'permission_prompt') return { ...state, lastNotification };
      return {
        ...state,
        lastNotification,
        notifs: [{ t: nowShort(), m: notificationReasonLabel(action.reason), c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };
    }

    case 'RECAP_RECEIVED':
      return { ...state, recap: action.recap };

    case 'DISMISS_RECAP':
      return { ...state, recap: null };

    case 'SET_DISPATCH_HEADLINE': {
      let dispatchHeadlines = { ...state.dispatchHeadlines, [action.toolUseId]: action.headline };
      const headlineKeys = Object.keys(dispatchHeadlines);
      if (headlineKeys.length > 100) {
        // Same eviction pattern as dispatchUsage above -- Object.keys() preserves
        // insertion order for these (non-integer-like) string keys, so this
        // evicts the oldest entries first, not a random subset.
        const toEvict = new Set(headlineKeys.slice(0, headlineKeys.length - 100));
        dispatchHeadlines = Object.fromEntries(Object.entries(dispatchHeadlines).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchHeadlines };
    }

    case 'SET_DISPATCH_NARRATION': {
      let dispatchNarrations = {
        ...state.dispatchNarrations,
        [action.toolUseId]: { narration: action.narration, severity: action.severity },
      };
      const narrationKeys = Object.keys(dispatchNarrations);
      if (narrationKeys.length > 100) {
        const toEvict = new Set(narrationKeys.slice(0, narrationKeys.length - 100));
        dispatchNarrations = Object.fromEntries(Object.entries(dispatchNarrations).filter(([k]) => !toEvict.has(k)));
      }
      // Give the completed dispatch a voice-pack line in its Comms channel too
      // (distinct from `dispatchNarrations` above, the roster card's model-written
      // line). subagentType isn't carried on this action, so resolve it from
      // whichever record still has it -- recentCompletedDispatches (freshest) first,
      // falling back to an already-created dispatch channel stub.
      const dispatchInfo =
        state.recentCompletedDispatches.find((d) => d.toolUseId === action.toolUseId) ??
        state.dispatchChannels.find((d) => d.toolUseId === action.toolUseId);
      let narrationMessages = state.narrationMessages;
      let narrationBudgets = state.narrationBudgets;
      if (dispatchInfo) {
        const applied = applyNarrationEvent(
          { kind: 'dispatchCompleted', toolUseId: action.toolUseId, subagentType: dispatchInfo.subagentType, severity: action.severity as 0 | 1 | 2 | 3 | 4 },
          state,
          narrationMessages,
          narrationBudgets
        );
        narrationMessages = applied.narrationMessages;
        narrationBudgets = applied.narrationBudgets;
      }
      return { ...state, dispatchNarrations, narrationMessages, narrationBudgets };
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
      const logs = state.logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
      return { ...state, dispatchChannels: [...state.dispatchChannels, stub], logs };
    }

    case 'REMOVE_DISPATCH_CHANNEL':
      return { ...state, dispatchChannels: state.dispatchChannels.filter((d) => d.toolUseId !== action.toolUseId) };

    case 'RECORD_DISPATCH_USAGE': {
      let dispatchUsage = state.dispatchUsage;
      let logs = state.logs;
      let notifs = state.notifs;
      let unread = state.unread;
      for (const c of action.completed) {
        dispatchUsage = { ...dispatchUsage, [c.toolUseId]: { tokens: c.tokens, toolUses: c.toolUses, durationMs: c.durationMs } };
        const summary = `${c.subagentType}: ${short(c.tokens)} tok · ${c.toolUses} tool call${c.toolUses === 1 ? '' : 's'} · ${fmtElapsed(c.durationMs)}`;
        logs = logs.concat({ t: nowLong(), m: summary, c: '#3be0a0' }).slice(-14);
        notifs = [{ t: nowShort(), m: summary, c: '#3be0a0' }, ...notifs].slice(0, 12);
        unread += 1;
      }
      const keys = Object.keys(dispatchUsage);
      if (keys.length > 100) {
        // Object.keys() preserves insertion order for non-integer-like string
        // keys (toolUseId values are never plain-integer strings) -- relied on
        // here to evict the oldest entries first, not a random subset.
        const toEvict = new Set(keys.slice(0, keys.length - 100));
        dispatchUsage = Object.fromEntries(Object.entries(dispatchUsage).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchUsage, logs, notifs, unread };
    }

    case 'SELECT_REAL_AGENT':
      return { ...state, selectedRealAgent: action.toolUseId };

    case 'RUN_COMMAND': {
      const result = runCommand(state, action.raw);
      const base = result.patch ? { ...state, ...result.patch } : state;
      return {
        ...base,
        cmdHist: [...base.cmdHist, action.raw].slice(-30),
        commandsRun: base.commandsRun + 1,
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
