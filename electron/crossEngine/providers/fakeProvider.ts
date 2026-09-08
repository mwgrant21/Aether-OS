// Scriptable in-memory ProviderAdapter.
//
// The broker plan's step 2 requires a fake-provider contract harness to exist
// BEFORE either real provider is connected, so that adapter lifecycle,
// cancellation, permission-denial, and budget behaviour are testable without
// credentials, network, or a spawned child process. It is also what lets the
// Windows CI lane exercise the cross-engine path at all: CI carries no Codex
// or Claude login, by design.
//
// This is a test/CI double. Nothing in the Electron main bundle imports it.

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
  type TurnUsage,
} from './contract';

export interface FakeScript {
  capabilities?: Partial<ProviderCapabilities>;
  health?: Partial<ProviderHealth>;
  /** Emitted in order as `message-chunk` events; concatenated into
   *  TurnResult.text, exactly as a real streaming provider would. */
  chunks?: string[];
  reasoningChunks?: string[];
  /** When set, a `permission-request` event is emitted mid-turn. The adapter
   *  always denies it -- the script cannot make it grant, because there is no
   *  grant path to script. */
  permissionRequest?: string;
  toolCalls?: Array<{ name: string; detail: string }>;
  usage?: TurnUsage;
  stopReason?: TurnStopReason;
  /** Throw a transport-level fault from sendTurn instead of returning. */
  failWith?: ProviderError;
  /** Yields to the event loop between chunks so a concurrent cancel() can
   *  land mid-turn in tests without real timers. */
  yieldBetweenChunks?: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  resumableSessions: false,
  streamingEvents: true,
  permissionRequests: true,
  usageReporting: true,
  cancellation: true,
  structuredOutputSchema: false,
};

export class FakeProvider implements ProviderAdapter {
  readonly id = 'fake' as const;

  private connected = false;
  private nextSession = 1;
  private readonly sessions = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** Every session the adapter ever opened, in order. Lets a test assert on
   *  sessions that have since been disposed. */
  readonly openedSessions: string[] = [];
  /** Every SessionOptions the adapter was handed, so a test can assert that
   *  an outputSchema was NOT forwarded by an adapter that reports
   *  structuredOutputSchema: false. */
  readonly sessionOptions: SessionOptions[] = [];

  constructor(private readonly script: FakeScript = {}) {}

  capabilities(): ProviderCapabilities {
    return { ...DEFAULT_CAPABILITIES, ...this.script.capabilities };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  private assertConnected(): void {
    if (!this.connected) throw new ProviderError('NOT_CONNECTED', 'fake provider is not connected');
  }

  async health(): Promise<ProviderHealth> {
    this.assertConnected();
    return {
      ready: true,
      authMode: 'subscription',
      version: 'fake-1',
      detail: 'fake provider',
      ...this.script.health,
    };
  }

  async newSession(options: SessionOptions): Promise<string> {
    this.assertConnected();
    const id = `fake-session-${this.nextSession++}`;
    this.sessions.add(id);
    this.openedSessions.push(id);
    this.sessionOptions.push(options);
    return id;
  }

  async sendTurn(request: TurnRequest, onEvent: (event: ProviderEvent) => void): Promise<TurnResult> {
    this.assertConnected();
    if (!this.sessions.has(request.sessionId)) {
      throw new ProviderError('UNKNOWN_SESSION', `no such session: ${request.sessionId}`);
    }
    if (this.script.failWith) throw this.script.failWith;

    const sessionId = request.sessionId;
    let text = '';

    for (const chunk of this.script.reasoningChunks ?? []) {
      onEvent({ kind: 'reasoning-chunk', sessionId, text: chunk });
    }
    for (const call of this.script.toolCalls ?? []) {
      onEvent({ kind: 'tool-call', sessionId, name: call.name, detail: call.detail });
    }
    if (this.script.permissionRequest) {
      // Denied unconditionally. There is no branch here that can grant.
      onEvent({
        kind: 'permission-request',
        sessionId,
        requestId: `${sessionId}-perm-1`,
        summary: this.script.permissionRequest,
        decision: 'denied',
      });
    }

    for (const chunk of this.script.chunks ?? []) {
      if (this.script.yieldBetweenChunks) await Promise.resolve();
      if (this.cancelled.has(sessionId)) {
        return { stopReason: 'cancelled', text, usage: this.script.usage ?? EMPTY_USAGE };
      }
      text += chunk;
      onEvent({ kind: 'message-chunk', sessionId, text: chunk });
    }

    if (this.cancelled.has(sessionId)) {
      return { stopReason: 'cancelled', text, usage: this.script.usage ?? EMPTY_USAGE };
    }

    const usage = this.script.usage ?? EMPTY_USAGE;
    onEvent({ kind: 'usage', sessionId, usage });
    return { stopReason: this.script.stopReason ?? 'completed', text, usage };
  }

  async cancel(sessionId: string): Promise<void> {
    // Unknown/finished sessions are a deliberate no-op, per the contract --
    // a cancel racing a completing turn must not become an error.
    this.cancelled.add(sessionId);
  }

  async dispose(): Promise<void> {
    this.connected = false;
    this.sessions.clear();
    this.cancelled.clear();
  }
}
