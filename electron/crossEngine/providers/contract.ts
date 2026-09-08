// Provider-neutral adapter contract for cross-engine deliberation.
//
// See ~/agent-improvement/prototyping-tasks/aether-cross-engine-deliberation-broker-2026-09-04.md
// ("Minimal prototype", step 3). Aether owns the conversation: Claude and
// Codex are driven THROUGH this interface by an Aether-side orchestrator, and
// are never registered as peers that can recursively invoke each other.
//
// The shape here is deliberately the intersection of what the two real
// control surfaces already expose, verified live against the installed
// runtimes on 2026-09-06 rather than assumed:
//
//   - Codex ACP (the adapter package acpProcess.ts resolves; this file
//     deliberately does not name the specifier -- see noApiCalls.test.ts):
//     session/new, session/prompt, session/update, session/request_permission.
//   - Codex app-server (codex-cli 0.153.2, `codex app-server`): thread/start,
//     thread/resume, turn/start, turn/interrupt, account/read,
//     account/rateLimits/read, plus item/* notifications and item/*
//     requestApproval server->client requests.
//
// The Claude side is `claude -p --output-format stream-json` (see
// claudeHeadlessCli.ts), chosen after probing all three candidates live.
// It is NOT shaped around `claude mcp serve`: that command was probed and
// exposes Claude Code's TOOLS to an MCP client, with no session, turn,
// cancellation, or approval semantics (its entire option surface is
// --debug/--verbose). The Claude Agent SDK would also work, but adds a runtime
// dependency and a second authentication path; the headless CLI needs neither
// and is already installed.

// camelCase, not kebab-case, and deliberately so: `src/shared/noApiCalls.test.ts`
// forbids the ACP adapter package's own kebab-case token outside the one reviewed
// module that resolves the adapter executable. A kebab-case id here would collide
// with that guard and force it to be loosened or allowlisted, weakening a real
// security boundary for a naming preference. These ids are opaque; nothing
// persists them yet, so renaming later would be a migration.
export type ProviderId = 'codexAcp' | 'codexAppServer' | 'claudeHeadlessCli' | 'fake';

export type ProviderErrorCode =
  | 'NOT_CONNECTED'
  | 'NOT_IMPLEMENTED'
  | 'AUTH_BLOCKED'
  | 'PROTOCOL_ERROR'
  | 'PROCESS_EXITED'
  | 'TIMEOUT'
  | 'UNKNOWN_SESSION';

/** Every adapter failure normalizes to one of these codes, so the
 *  orchestrator's stop-reason logic never has to string-match a provider's
 *  own error text. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ProviderCapabilities {
  /** A session id survives adapter reconnection and can be resumed.
   *  ACP: no. app-server: yes (thread/resume). */
  resumableSessions: boolean;
  /** Incremental events arrive during a turn rather than only at the end. */
  streamingEvents: boolean;
  /** The provider asks the client for permission mid-turn (which this
   *  prototype always denies -- see PermissionDecision). */
  permissionRequests: boolean;
  /** Per-turn token usage is reported by the provider itself, not inferred. */
  usageReporting: boolean;
  /** An in-flight turn can be interrupted. ACP: only by killing the process.
   *  app-server: yes (turn/interrupt). */
  cancellation: boolean;
  /** The final assistant message can be constrained by a JSON Schema at the
   *  protocol level (app-server's TurnStartParams.outputSchema) rather than
   *  by asking the model nicely and parsing defensively afterwards. */
  structuredOutputSchema: boolean;
}

export type ProviderAuthMode = 'subscription' | 'api-key' | 'gateway' | 'unauthenticated' | 'unknown';

export interface ProviderHealth {
  /** True only when the provider is provably usable under this project's
   *  billing policy. Anything unproven fails closed to false. */
  ready: boolean;
  authMode: ProviderAuthMode;
  version: string | null;
  detail: string;
}

/**
 * Per-turn token usage, in FOUR DISJOINT buckets.
 *
 * Disjoint is the load-bearing word, and it is a contract every adapter owes
 * rather than a property the wire format supplies. Codex's app-server reports
 * them NESTED -- `ThreadTokenUsage.last.inputTokens` includes
 * `cachedInputTokens`, and `outputTokens` includes `reasoningOutputTokens`
 * (Codex's own `TokenUsage::non_cached_input()` subtracts the cache bucket for
 * exactly this reason). Copying those straight through means any consumer that
 * sums the buckets -- the broker ledger being the one that will -- counts every
 * cached token twice and every reasoning token twice, silently, with no
 * anomaly to notice.
 *
 * So the adapter subtracts, and this type states the post-subtraction meaning:
 *   inputTokens   FRESH input only. EXCLUDES cachedInputTokens.
 *   outputTokens  VISIBLE output only. EXCLUDES reasoningOutputTokens.
 * Which makes `inputTokens + outputTokens + cachedInputTokens +
 * reasoningOutputTokens` a correct grand total, and makes it correct for every
 * provider rather than for whichever one the caller happened to have in mind.
 *
 * Claude's `claude -p` result usage is already disjoint (`input_tokens`
 * excludes `cache_read_input_tokens`) and reports no separate reasoning
 * bucket, so its adapter subtracts nothing and reports
 * `reasoningOutputTokens: null`.
 *
 * `null` means NOT REPORTED, and is deliberately different from 0. An adapter
 * with usageReporting: false reports four nulls rather than four zeros.
 */
export interface TurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
}

export const EMPTY_USAGE: TurnUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
});

/** Deliberately a single-member union. Widening it later is a visible type
 *  change that forces every call site to be re-read, rather than a silent
 *  behavioural drift from "read-only by policy" to "sometimes writes". */
export type PermissionDecision = 'denied';

export type ProviderEvent =
  | { kind: 'message-chunk'; sessionId: string; text: string }
  | { kind: 'reasoning-chunk'; sessionId: string; text: string }
  | { kind: 'tool-call'; sessionId: string; name: string; detail: string }
  | { kind: 'permission-request'; sessionId: string; requestId: string; summary: string; decision: PermissionDecision }
  | { kind: 'usage'; sessionId: string; usage: TurnUsage };

export type TurnStopReason = 'completed' | 'cancelled' | 'refused' | 'timeout' | 'error';

export interface TurnResult {
  stopReason: TurnStopReason;
  /** Raw accumulated assistant text. Never parsed by the adapter -- parsing
   *  and schema validation belong to the orchestrator, so a malformed
   *  response is a policy decision rather than an adapter crash. */
  text: string;
  usage: TurnUsage;
}

export interface SessionOptions {
  cwd: string;
  /** JSON Schema for the final assistant message. Adapters that report
   *  structuredOutputSchema: false MUST ignore this rather than fake it. */
  outputSchema?: unknown;
}

export interface TurnRequest {
  sessionId: string;
  text: string;
  timeoutMs?: number;
}

/**
 * Lifecycle contract, enforced by providerConformance.ts against every
 * adapter including the fake:
 *
 *   1. connect() before anything else. newSession/sendTurn/health before
 *      connect() throw ProviderError('NOT_CONNECTED').
 *   2. dispose() is idempotent and returns the adapter to the not-connected
 *      state, so post-dispose calls throw NOT_CONNECTED too.
 *   3. sendTurn() never throws for a provider-side refusal or timeout -- it
 *      returns a TurnResult carrying the stop reason. It throws only for
 *      transport/lifecycle faults.
 *   4. cancel() on an unknown or already-finished session is a no-op, never
 *      an error.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  connect(): Promise<void>;
  health(): Promise<ProviderHealth>;
  newSession(options: SessionOptions): Promise<string>;
  sendTurn(request: TurnRequest, onEvent: (event: ProviderEvent) => void): Promise<TurnResult>;
  cancel(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
