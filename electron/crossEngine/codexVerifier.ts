import type { DatabaseSync } from 'node:sqlite';
import type { GitProbe } from '../../src/shared/projectIdentity';
import { resolveDispatchEvidence } from './dispatchEvidence';
import { buildVerificationSnapshot } from './snapshotBuilder';
import { buildVerificationPrompt } from './verificationPrompt';
import { parseVerificationResult } from './verificationResult';
import { AcpClient } from './acpClient';
import { isAllowedAuthStatus } from './codexSubscriptionPolicy';
import type { VerificationRequest, VerificationResultV1, VerificationEvent } from '../../src/shared/crossEngineTypes';

const RUN_TIMEOUT_MS = 5 * 60_000;

export class CodexVerifier {
  private activeRunId: string | null = null;
  private activeClient: AcpClient | null = null;
  // Independent of activeClient: cancel() can land while run() is still
  // awaiting resolveDispatchEvidence/buildVerificationSnapshot, before
  // activeClient.connect() is ever called -- disposing a not-yet-connected
  // client has no effect, so run()'s prep sequence checks this flag itself
  // after every await instead of relying solely on client disposal.
  private cancelled = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionDir: string,
    private readonly pinnedSessionId: string,
    private readonly gitProbe: GitProbe
  ) {}

  async run(runId: string, request: VerificationRequest, onEvent: (e: VerificationEvent) => void): Promise<VerificationResultV1> {
    if (this.activeRunId) throw new Error('a verification run is already in progress');
    this.activeRunId = runId;
    this.cancelled = false;

    let dispose: (() => Promise<void>) | null = null;
    const client = new AcpClient();
    this.activeClient = client;

    const cancelledResult = async (): Promise<VerificationResultV1> => {
      if (dispose) await dispose();
      const message = 'Verification was cancelled.';
      onEvent({ kind: 'cancelled', runId });
      return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: message, findings: [], tests: [], limitations: [message] };
    };

    try {
      onEvent({ kind: 'status', runId, phase: 'preparing-evidence' });
      const evidenceResult = await resolveDispatchEvidence(request.toolUseId, this.db, this.sessionDir, this.pinnedSessionId, this.gitProbe);
      if (this.cancelled) return await cancelledResult();
      if (!evidenceResult.ok) {
        onEvent({ kind: 'error', runId, code: 'EVIDENCE_INCOMPLETE', message: evidenceResult.missing });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: evidenceResult.missing, findings: [], tests: [], limitations: [evidenceResult.missing] };
      }

      onEvent({ kind: 'status', runId, phase: 'creating-snapshot' });
      const snapshot = await buildVerificationSnapshot(evidenceResult.evidence);
      dispose = snapshot.dispose;
      if (this.cancelled) return await cancelledResult();

      onEvent({ kind: 'status', runId, phase: 'checking-auth' });
      client.connect();
      await client.initialize();
      await client.authenticate();
      const status = await client.authenticationStatus();
      if (this.cancelled) return await cancelledResult();
      if (!isAllowedAuthStatus(status)) {
        const message = `Codex authentication is not subscription-only (status: ${status}); refusing to run.`;
        onEvent({ kind: 'error', runId, code: 'BILLING_MODE_BLOCKED', message });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: message, findings: [], tests: [], limitations: [message] };
      }

      onEvent({ kind: 'status', runId, phase: 'verifying' });
      const prompt = buildVerificationPrompt(evidenceResult.evidence);
      let raw: unknown;
      try {
        raw = await this.promptWithTimeout(client, snapshot.snapshotDir, prompt, RUN_TIMEOUT_MS);
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'VERIFICATION_TIMEOUT';
        const code = isTimeout ? 'VERIFICATION_TIMEOUT' : 'RESULT_INVALID';
        const message = isTimeout
          ? `Codex verification did not complete within ${RUN_TIMEOUT_MS / 60_000} minutes; the run was cancelled.`
          : `Codex verification prompt failed: ${err instanceof Error ? err.message : String(err)}`;
        onEvent({ kind: 'error', runId, code, message });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: message, findings: [], tests: [], limitations: [message] };
      }
      const result = parseVerificationResult(raw);
      onEvent({ kind: 'result', runId, result });
      return result;
    } finally {
      await client.dispose();
      if (dispose) await dispose();
      this.activeRunId = null;
      this.activeClient = null;
    }
  }

  private async promptWithTimeout(client: AcpClient, snapshotDir: string, prompt: string, timeoutMs: number): Promise<unknown> {
    // Delegates to AcpClient.prompt(), which itself creates the session
    // (session/new with mcpServers: []) and sends session/prompt. There is
    // no request-level "read-only / no MCP / no web search" flag in the real
    // ACP wire format (see acpClient.ts's prompt() doc comment) -- no MCP
    // servers are ever connected, and read-only is enforced by AcpClient
    // denying every session/request_permission the agent sends mid-turn.
    return Promise.race([
      client.prompt({ cwd: snapshotDir, text: prompt }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('VERIFICATION_TIMEOUT')), timeoutMs)),
    ]);
  }

  async cancel(runId: string): Promise<void> {
    if (this.activeRunId !== runId) return;
    this.cancelled = true;
    // activeClient may not exist yet (cancellation landed during evidence
    // resolution / snapshot creation, before client.connect() is called) --
    // the cancelled flag alone covers that case; disposing the client here
    // additionally unblocks an outstanding connect/prompt call if one exists.
    if (this.activeClient) await this.activeClient.dispose();
  }
}
