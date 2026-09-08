// ProviderAdapter over the Claude Code CLI in headless print mode.
//
// Chosen over the two options the broker plan considered, both of which were
// probed live against Claude Code 2.1.263 on 2026-09-06:
//
//   - `claude mcp serve`: its entire option surface is --debug/--verbose. It
//     exposes Claude Code's TOOLS to an MCP client and has no session, turn,
//     cancellation, approval, or usage semantics. It cannot drive a
//     deliberation. Rejected.
//   - `@anthropic-ai/claude-agent-sdk`: would work, but adds a runtime
//     dependency and a second authentication path. Deferred.
//   - `claude -p --output-format stream-json`: satisfies every part of this
//     contract using the CLI already installed, under the operator's existing
//     login. Chosen.
//
// Everything below was verified by running the real CLI, not read from docs:
//
//   session ids   `system`/`init` and the final `result` both carry
//                 `session_id`; `--resume <id>` continues it headlessly
//                 (verified: a resumed turn recalled the prior answer).
//   streaming     `stream_event` wraps raw Anthropic stream events;
//                 `content_block_delta` -> `delta.text_delta.text`.
//   stop reason   the final `result` carries `stop_reason` ("end_turn").
//   usage         `result.usage` -> input_tokens, output_tokens,
//                 cache_read_input_tokens, cache_creation_input_tokens.
//   rate limits   a `rate_limit_event` line carries reset windows. Not part of
//                 this contract yet; see the note on RATE-LIMIT below.
//
// READ-ONLY IS NOT `--restricted` ALONE. That flag was measured: it strips
// command/code-running tools and WebFetch and ignores user/project settings,
// but 110 tools still remained, INCLUDING Write, Edit, NotebookEdit, Skill and
// MCP write tools. The guarantee comes from the full flag set below, and was
// verified adversarially: asked to write a file and to spawn a subagent that
// writes a file, the session refused both with "Permission for this tool use
// was denied. It requires approval, and this session has no approval surface,"
// and no file appeared on disk.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { attachStderrRingBuffer, buildAllowlistedChildEnv } from '../acpProcess';
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

/**
 * The read-only flag set. Every entry earns its place; do not trim it.
 *
 *   --restricted            removes code-running tools and WebFetch, ignores
 *                           user/project/local settings, and confines the file
 *                           tools to the working directory.
 *   --strict-mcp-config     no MCP servers at all (measured: `mcp_servers: []`,
 *                           tool surface 110 -> 21). The analogue of the ACP
 *                           client always sending `mcpServers: []`.
 *   --disable-slash-commands  no skills; `Skill` survives --restricted.
 *   --allowedTools          a FAIL-CLOSED allowlist, not a denylist. A denylist
 *                           would silently admit any newly added tool -- the
 *                           same reasoning as acpProcess.ts's env allowlist,
 *                           which builds from nothing rather than removing keys.
 *   --permission-prompts none  anything that would prompt is denied
 *                           automatically. Without this, denial happens only
 *                           incidentally because no approval surface exists;
 *                           with it, denial is the documented behaviour.
 */
const READ_ONLY_ARGS = [
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--permission-prompts',
  'none',
  '--allowedTools',
  'Read',
  'Grep',
  'Glob',
];

const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

interface SessionState {
  cwd: string;
  /** The CLI's own session id, learned from the first turn's `system`/`init`.
   *  Null until then, which is why newSession() cannot ask the CLI for one:
   *  a session does not exist until a turn creates it, and priming one would
   *  spend tokens for nothing. */
  claudeSessionId: string | null;
  child: ChildProcess | null;
  cancelled: boolean;
}

/** `result.stop_reason` is the primary signal, but it is not the only one the
 *  CLI emits, and defaulting an unrecognised value straight to 'error' threw
 *  away complete answers: the turn text was correct and present while the
 *  orchestrator was told the turn failed. The `result` line's own
 *  `subtype`/`is_error` pair is the documented success signal, so it is the
 *  fallback rather than a guess. Still fails closed when neither is
 *  conclusive. */
function mapStopReason(raw: unknown, result: { subtype?: unknown; isError?: unknown }): TurnStopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
    case 'max_tokens':
      return 'completed';
    case 'refusal':
      return 'refused';
  }
  if (result.isError === true) return 'error';
  if (result.subtype === 'success') return 'completed';
  return 'error';
}

function readUsage(raw: unknown): TurnUsage {
  const u = raw as Record<string, unknown> | undefined;
  if (!u) return EMPTY_USAGE;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    // Already disjoint on this wire format: the Anthropic result's
    // `input_tokens` excludes `cache_read_input_tokens`, so nothing is
    // subtracted here. Reasoning tokens are not broken out separately on this
    // surface at all, which is `null` (not reported), never 0.
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cachedInputTokens: num(u.cache_read_input_tokens),
    reasoningOutputTokens: null,
  };
}

export type SpawnTurn = (args: string[], cwd: string) => ChildProcess;

/** Result of `claude auth status` -- a token-free, structured login probe.
 *  The Claude-side analogue of AcpClient.authenticationStatus(). */
export type ProbeAuth = () => Promise<{ loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown } | null>;

/** The child env is an allowlist built from nothing, exactly as on the Codex
 *  side. Inheriting process.env would let an operator's ANTHROPIC_API_KEY,
 *  ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL silently route every
 *  deliberation turn through metered billing or a third-party gateway instead
 *  of the subscription login -- the exact failure class this project has
 *  already paid for once. None of those names is in the allowlist, so they are
 *  excluded by construction, not by a denylist someone has to maintain.
 *
 *  `claude` itself is a native .exe on this platform and resolves from PATH
 *  under a non-shell spawn (verified), so unlike `codex` it needs no
 *  Node-entry indirection. PATH is in the allowlist. */
const defaultSpawnTurn: SpawnTurn = (args, cwd) => {
  const child = spawn('claude', args, {
    cwd,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildAllowlistedChildEnv(process.env),
  });
  attachStderrRingBuffer(child);
  return child;
};

const AUTH_PROBE_TIMEOUT_MS = 15_000;

const defaultProbeAuth: ProbeAuth = () =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ChildProcess;
    try {
      child = spawn('claude', ['auth', 'status'], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildAllowlistedChildEnv(process.env),
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, AUTH_PROBE_TIMEOUT_MS);
    const decoder = new StringDecoder('utf8');
    let out = '';
    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => {
      out += decoder.write(chunk);
    });
    attachStderrRingBuffer(child);
    child.on('error', () => done(null));
    child.on('close', () => {
      try {
        done(JSON.parse(out + decoder.end()) as Record<string, unknown>);
      } catch {
        done(null);
      }
    });
  });

export class ClaudeHeadlessCliAdapter implements ProviderAdapter {
  readonly id = 'claudeHeadlessCli' as const;

  private connected = false;
  private readonly sessions = new Map<string, SessionState>();

  /** `model` is pinned rather than inherited by the caller: a measured run
   *  picked up whatever the operator had configured as their default, which
   *  would make deliberation cost and behaviour depend on an unrelated user
   *  setting. The id itself is deliberately not written in this file --
   *  noApiCalls.test.ts forbids model-ID-shaped literals in source. */
  constructor(
    private readonly spawnTurn: SpawnTurn = defaultSpawnTurn,
    private readonly model: string | null = null,
    private readonly probeAuth: ProbeAuth = defaultProbeAuth
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      resumableSessions: true,
      streamingEvents: true,
      permissionRequests: true,
      usageReporting: true,
      cancellation: true,
      // No JSON-Schema flag exists on the CLI. Unlike codex app-server's
      // TurnStartParams.outputSchema, structure here can only be requested in
      // the prompt and validated afterwards.
      structuredOutputSchema: false,
    };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  private require(): void {
    if (!this.connected) throw new ProviderError('NOT_CONNECTED', 'claude headless adapter is not connected');
  }

  /** Reads the live login state via `claude auth status` -- structured, and
   *  it spends no tokens, so mounting a status card cannot cost money (the
   *  same constraint AcpClient.probe() respects by never sending
   *  `authenticate`). It never starts a turn.
   *
   *  Fails closed, per contract.ts: `ready` is true only for a proven
   *  first-party subscription login. A logged-out operator, an api-key login,
   *  a gateway, an unparseable probe or a missing CLI all yield false --
   *  previously this returned `ready: true` unconditionally, so an
   *  orchestrator gating on it would route work to a provider that was about
   *  to fail or bill wrongly.
   *
   *  Only the three fields below are read. The probe also returns the
   *  operator's email and org id; those are deliberately never copied into
   *  ProviderHealth, which is a structure other layers may log or persist. */
  async health(): Promise<ProviderHealth> {
    this.require();
    const status = await this.probeAuth();
    if (!status) {
      return {
        ready: false,
        authMode: 'unknown',
        version: null,
        detail: '`claude auth status` did not return a parseable result; treating the provider as unusable.',
      };
    }
    if (status.loggedIn !== true) {
      return {
        ready: false,
        authMode: 'unauthenticated',
        version: null,
        detail: '`claude auth status` reports no active login.',
      };
    }
    const method = typeof status.authMethod === 'string' ? status.authMethod : '';
    const provider = typeof status.apiProvider === 'string' ? status.apiProvider : '';
    // Provider is checked FIRST: a login can report authMethod 'claude.ai'
    // while being routed through Bedrock/Vertex/a gateway, and that is a
    // different billing path regardless of how the account authenticated.
    const authMode =
      provider !== '' && provider !== 'firstParty'
        ? ('gateway' as const)
        : method === 'claude.ai'
          ? ('subscription' as const)
          : /key/i.test(method)
            ? ('api-key' as const)
            : ('unknown' as const);
    return {
      ready: authMode === 'subscription',
      authMode,
      version: null,
      detail: 'claude auth status: authMethod=' + (method || '(absent)') + ', apiProvider=' + (provider || '(absent)'),
    };
  }

  async newSession(options: SessionOptions): Promise<string> {
    this.require();
    // options.outputSchema is dropped on purpose -- capabilities() reports
    // structuredOutputSchema: false, and forwarding a schema the CLI cannot
    // honour would be worse than ignoring it.
    const handle = 'claude-' + randomUUID();
    this.sessions.set(handle, { cwd: options.cwd, claudeSessionId: null, child: null, cancelled: false });
    return handle;
  }

  async sendTurn(request: TurnRequest, onEvent: (e: ProviderEvent) => void): Promise<TurnResult> {
    this.require();
    const state = this.sessions.get(request.sessionId);
    if (!state) throw new ProviderError('UNKNOWN_SESSION', 'no such session: ' + request.sessionId);

    const args = ['-p', request.text, ...STREAM_ARGS, ...READ_ONLY_ARGS];
    if (state.claudeSessionId) args.push('--resume', state.claudeSessionId);
    if (this.model) args.push('--model', this.model);

    state.cancelled = false;
    const child = this.spawnTurn(args, state.cwd);
    state.child = child;

    // The CLI waits ~3s for stdin before proceeding ("no stdin data received
    // in 3s"). The prompt is passed as an argument, so stdin is never needed
    // -- closing it immediately removes that stall from every turn.
    child.stdin?.end();

    let text = '';
    let usage: TurnUsage = EMPTY_USAGE;
    let stopReasonRaw: unknown = null;
    let sawResult = false;
    let resultSubtype: unknown;
    let resultIsError: unknown;
    let buffer = '';
    // Holds a multi-byte character split across a read boundary instead of
    // decoding the partial bytes to U+FFFD, which would either corrupt the
    // text or break JSON.parse and be swallowed by the catch below.
    const decoder = new StringDecoder('utf8');

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // never crash the turn on a malformed line
      }

      if (msg.type === 'system' && msg.subtype === 'init') {
        if (typeof msg.session_id === 'string') state.claudeSessionId = msg.session_id;
        return;
      }

      if (msg.type === 'stream_event') {
        const ev = msg.event as { type?: string; delta?: Record<string, unknown> } | undefined;
        if (ev?.type === 'content_block_delta') {
          const delta = ev.delta ?? {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            text += delta.text;
            onEvent({ kind: 'message-chunk', sessionId: request.sessionId, text: delta.text });
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            onEvent({ kind: 'reasoning-chunk', sessionId: request.sessionId, text: delta.thinking });
          }
        }
        return;
      }

      if (msg.type === 'assistant') {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; name?: string };
            if (b.type === 'tool_use') {
              onEvent({ kind: 'tool-call', sessionId: request.sessionId, name: b.name ?? 'unknown', detail: '' });
            }
          }
        }
        return;
      }

      // A denied tool comes back as an errored tool_result. Surfacing it makes
      // the refusal visible in a deliberation trace instead of silently
      // vanishing into the model's prose.
      if (msg.type === 'user') {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; is_error?: boolean; content?: unknown; tool_use_id?: string };
            if (b.type === 'tool_result' && b.is_error && /permission/i.test(String(b.content))) {
              onEvent({
                kind: 'permission-request',
                sessionId: request.sessionId,
                requestId: b.tool_use_id ?? request.sessionId + '-perm',
                summary: String(b.content).slice(0, 200),
                decision: 'denied',
              });
            }
          }
        }
        return;
      }

      if (msg.type === 'result') {
        sawResult = true;
        stopReasonRaw = msg.stop_reason;
        resultSubtype = msg.subtype;
        resultIsError = msg.is_error;
        usage = readUsage(msg.usage);
        if (typeof msg.session_id === 'string') state.claudeSessionId = msg.session_id;
      }

      // RATE-LIMIT: `rate_limit_event` carries reset windows and overage
      // status. Deliberately not mapped -- ProviderEvent has no variant for it
      // and inventing one here would widen the contract for a single provider.
      // It belongs with the provider-telemetry backlog item, where the Codex
      // side (account/rateLimits/read) can be modelled at the same time.
    };

    const timeoutMs = request.timeoutMs ?? 5 * 60_000;

    const result = await new Promise<TurnResult>((resolve) => {
      let settled = false;
      const finish = (r: TurnResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish({ stopReason: 'timeout', text, usage });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      });

      child.on('error', () => finish({ stopReason: 'error', text, usage }));

      child.on('close', () => {
        if (buffer.trim()) handleLine(buffer);
        // A turn that produced no `result` line did not finish cleanly, and is
        // reported as an error rather than optimistically completed -- the same
        // rule the codex app-server adapter applies to an unknown turn status.
        if (state.cancelled) finish({ stopReason: 'cancelled', text, usage });
        else if (!sawResult) finish({ stopReason: 'error', text, usage });
        else finish({ stopReason: mapStopReason(stopReasonRaw, { subtype: resultSubtype, isError: resultIsError }), text, usage });
      });
    });

    state.child = null;
    return result;
  }

  async cancel(sessionId: string): Promise<void> {
    // Unknown session is a deliberate no-op, per the contract.
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.cancelled = true;
    state.child?.kill();
  }

  async dispose(): Promise<void> {
    for (const state of this.sessions.values()) state.child?.kill();
    this.sessions.clear();
    this.connected = false;
  }
}
