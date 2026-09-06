// ProviderAdapter over the ACP transport that ships today.
//
// The broker plan requires the existing one-shot Codex verification path to
// keep working, unchanged, until the app-server adapter reaches parity --
// "Preserve current one-shot VerificationResultV1 behavior through an
// adapter-parity test before retiring ACP." This adapter is that bridge: it
// puts the shipped AcpClient behind the provider-neutral contract without
// altering codexVerifier.ts, which still drives AcpClient directly.
//
// It is deliberately the weaker of the two Codex adapters, and says so in
// capabilities() rather than pretending otherwise:
//
//   - No resumable sessions: ACP session ids die with the child process.
//   - No turn-level cancellation: the protocol has no `turn/interrupt`
//     equivalent, so the only interrupt available is killing the adapter
//     process, which is not per-session.
//   - No usage reporting: PromptResponse may carry token usage, but
//     AcpClient does not surface it and this adapter will not invent it.
//   - No structured output schema: read-only and JSON-shaped output are
//     requested in the prompt text and validated afterwards, not enforced
//     by the protocol.

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpClient } from '../acpClient';
import { isAllowedAuthStatus, offersChatGptAuthMethod } from '../codexSubscriptionPolicy';
import {
  EMPTY_USAGE,
  ProviderError,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderHealth,
  type SessionOptions,
  type TurnRequest,
  type TurnResult,
  type TurnStopReason,
} from './contract';

export class LegacyCodexAcpAdapter implements ProviderAdapter {
  readonly id = 'codexAcp' as const;

  private connected = false;
  private readonly sessions = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** Sessions with a turn in flight right now. cancel() only records against
   *  these: marking an idle session leaves a flag no sendTurn will clear, and
   *  the NEXT turn on that session then reports 'cancelled' and discards a
   *  perfectly good answer. */
  private readonly activeTurns = new Set<string>();

  /** `child` is injectable purely so the conformance suite and unit tests can
   *  drive a PassThrough pair instead of spawning the real adapter -- the
   *  same seam acpClient.test.ts already uses. */
  constructor(
    private readonly client: AcpClient = new AcpClient(),
    private readonly child?: ChildProcessWithoutNullStreams
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      resumableSessions: false,
      streamingEvents: true,
      permissionRequests: true,
      usageReporting: false,
      cancellation: false,
      structuredOutputSchema: false,
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // AcpClient.connect()'s parameter defaults to spawnAcpProcess(); passing
    // an explicit undefined selects that default, so both paths go through
    // one call.
    this.client.connect(this.child);
    this.connected = true;
  }

  private require(): void {
    if (!this.connected) throw new ProviderError('NOT_CONNECTED', 'codex ACP adapter is not connected');
  }

  async health(): Promise<ProviderHealth> {
    this.require();
    try {
      const methods = await this.client.initialize();
      if (!offersChatGptAuthMethod(methods)) {
        return {
          ready: false,
          authMode: 'unknown',
          version: null,
          detail: 'adapter did not offer ChatGPT subscription authentication',
        };
      }
      const status = await this.client.authenticationStatus();
      const authMode =
        status === 'chat-gpt'
          ? ('subscription' as const)
          : status === 'api-key'
            ? ('api-key' as const)
            : status === 'gateway'
              ? ('gateway' as const)
              : status === 'unauthenticated'
                ? ('unauthenticated' as const)
                : ('unknown' as const);
      return {
        ready: isAllowedAuthStatus(status),
        authMode,
        version: null,
        detail: 'authentication/status reported ' + status,
      };
    } catch (err) {
      return {
        ready: false,
        authMode: 'unknown',
        version: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async newSession(options: SessionOptions): Promise<string> {
    this.require();
    // options.outputSchema is deliberately dropped: capabilities() reports
    // structuredOutputSchema: false, and silently forwarding a schema the
    // protocol cannot honour would be worse than ignoring it.
    const sessionId = await this.client.newSession(options.cwd);
    this.sessions.add(sessionId);
    return sessionId;
  }

  async sendTurn(request: TurnRequest, onEvent: (e: ProviderEvent) => void): Promise<TurnResult> {
    this.require();
    if (!this.sessions.has(request.sessionId)) {
      throw new ProviderError('UNKNOWN_SESSION', 'no such session: ' + request.sessionId);
    }

    this.activeTurns.add(request.sessionId);
    // Accumulated here as well as inside AcpClient, because AcpClient discards
    // its own buffer in a finally block -- so on timeout the partial answer is
    // only recoverable from this copy (finding 10).
    let streamed = '';
    const previous = this.client.onStreamEvent;
    this.client.onStreamEvent = (e) => {
      if (e.sessionId && e.sessionId !== request.sessionId) return;
      if (e.kind === 'message') {
        streamed += e.text;
        onEvent({ kind: 'message-chunk', sessionId: request.sessionId, text: e.text });
      }
      else if (e.kind === 'reasoning') onEvent({ kind: 'reasoning-chunk', sessionId: request.sessionId, text: e.text });
      else if (e.kind === 'tool') onEvent({ kind: 'tool-call', sessionId: request.sessionId, name: e.text, detail: '' });
      else
        onEvent({
          kind: 'permission-request',
          sessionId: request.sessionId,
          requestId: request.sessionId + '-perm',
          summary: e.text,
          decision: 'denied',
        });
    };

    try {
      const { text, stopReason } = await this.client.promptSessionRaw(
        request.sessionId,
        request.text,
        request.timeoutMs ?? 5 * 60_000
      );
      // ACP's stopReason vocabulary is not this contract's. Only the two
      // values that map unambiguously are translated; everything else is a
      // completed turn whose text the orchestrator must judge on its merits.
      const mapped: TurnStopReason = this.cancelled.has(request.sessionId)
        ? 'cancelled'
        : stopReason === 'refusal'
          ? 'refused'
          : stopReason === 'cancelled'
            ? 'cancelled'
            : 'completed';
      return { stopReason: mapped, text, usage: EMPTY_USAGE };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('timed out')) {
        // Return what actually arrived. Discarding it made a long answer that
        // timed out on its last chunk indistinguishable from one that produced
        // nothing at all, unlike both other adapters.
        return { stopReason: 'timeout', text: streamed, usage: EMPTY_USAGE };
      }
      if (message === 'not connected' || message === 'client disposed') {
        throw new ProviderError('PROCESS_EXITED', message);
      }
      throw new ProviderError('PROTOCOL_ERROR', message);
    } finally {
      this.client.onStreamEvent = previous;
      this.activeTurns.delete(request.sessionId);
      this.cancelled.delete(request.sessionId);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // Only meaningful while a turn is actually in flight. The contract calls
    // cancel() on an idle or finished session a no-op, and it has to be one
    // here too: a flag set with no sendTurn running is never cleared, so the
    // session's NEXT turn would report 'cancelled' and throw away a complete
    // answer. Never throws, per the contract.
    if (!this.activeTurns.has(sessionId)) return;
    this.cancelled.add(sessionId);
  }

  async dispose(): Promise<void> {
    this.connected = false;
    this.sessions.clear();
    this.cancelled.clear();
    this.client.onStreamEvent = null;
    await this.client.dispose();
  }
}
