// Declared-but-unimplemented Claude ProviderAdapter.
//
// This is a deliberate stub, not an oversight, and the reason is a probe
// result rather than an assumption. On 2026-09-06 the two candidate Claude
// control surfaces named in the broker plan's open question were checked
// against the installed CLI (Claude Code 2.1.263):
//
//   `claude mcp serve --help` -> options are exactly --debug and --verbose.
//
// That command exposes Claude Code's TOOLS to an MCP client. It has no
// session, turn, cancellation, approval, or usage semantics, so it cannot
// drive the Claude side of a deliberation. The plan's open question --
// "Does `claude mcp serve` expose sufficient session, cancellation, approval,
// and event semantics, or should the first Claude adapter use the Agent SDK?"
// -- therefore resolves against it. A real adapter needs
// @anthropic-ai/claude-agent-sdk, which is NOT a dependency of this project
// today.
//
// Adding it is a deliberate decision with real consequences (a new runtime
// dependency and a second authentication path to reason about), so it is left
// to its own scoped task rather than smuggled in here. Until then this class
// exists so that:
//
//   1. The provider-neutral contract is shaped by more than one vendor, which
//      is the entire point of having a contract.
//   2. providerConformance.ts already covers its pre-connect behaviour, so the
//      eventual implementation is a drop-in rather than a redesign.
//   3. Any call site that reaches for a Claude provider fails loudly with
//      NOT_IMPLEMENTED instead of silently degrading to Codex-only.
//
// Implementation note for whoever picks this up: the SDK's session/turn model
// maps onto this contract without widening it -- newSession -> a query
// session, sendTurn -> one turn with streamed events, cancel -> the SDK's
// abort signal, health -> the SDK's auth/model probe. If something genuinely
// does not fit, change contract.ts deliberately and re-run the conformance
// suite against every adapter, rather than special-casing Claude here.

import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderHealth,
  type SessionOptions,
  type TurnRequest,
  type TurnResult,
} from './contract';

const NOT_IMPLEMENTED =
  'Claude provider is not implemented: `claude mcp serve` exposes tools, not turns, ' +
  'and @anthropic-ai/claude-agent-sdk is not a dependency of this project yet.';

export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  readonly id = 'claude-agent-sdk' as const;

  /** Reports what a real Agent SDK adapter WILL support, so a capability-gated
   *  caller written against this stub does not have to be rewritten once the
   *  implementation lands. Nothing consults capabilities() to decide whether
   *  the adapter works -- connect() is the gate, and it always throws. */
  capabilities(): ProviderCapabilities {
    return {
      resumableSessions: true,
      streamingEvents: true,
      permissionRequests: true,
      usageReporting: true,
      cancellation: true,
      structuredOutputSchema: false,
    };
  }

  async connect(): Promise<void> {
    throw new ProviderError('NOT_IMPLEMENTED', NOT_IMPLEMENTED);
  }

  // Every remaining method reports NOT_CONNECTED rather than NOT_IMPLEMENTED:
  // connect() is the single place that explains the situation, and the
  // lifecycle contract (and its conformance test) requires pre-connect calls
  // to fail as not-connected regardless of the reason.

  async health(): Promise<ProviderHealth> {
    throw new ProviderError('NOT_CONNECTED', NOT_IMPLEMENTED);
  }

  async newSession(_options: SessionOptions): Promise<string> {
    throw new ProviderError('NOT_CONNECTED', NOT_IMPLEMENTED);
  }

  async sendTurn(_request: TurnRequest, _onEvent: (e: ProviderEvent) => void): Promise<TurnResult> {
    throw new ProviderError('NOT_CONNECTED', NOT_IMPLEMENTED);
  }

  async cancel(_sessionId: string): Promise<void> {
    // No-op, per the contract: cancel never throws.
  }

  async dispose(): Promise<void> {
    // Nothing to tear down; dispose is idempotent by construction.
  }
}
