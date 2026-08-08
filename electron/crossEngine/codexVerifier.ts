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

  constructor(
    private readonly db: DatabaseSync,
    private readonly sessionDir: string,
    private readonly pinnedSessionId: string,
    private readonly gitProbe: GitProbe
  ) {}

  async run(runId: string, request: VerificationRequest, onEvent: (e: VerificationEvent) => void): Promise<VerificationResultV1> {
    if (this.activeRunId) throw new Error('a verification run is already in progress');
    this.activeRunId = runId;

    let dispose: (() => Promise<void>) | null = null;
    const client = new AcpClient();
    this.activeClient = client;

    try {
      onEvent({ kind: 'status', runId, phase: 'preparing-evidence' });
      const evidenceResult = await resolveDispatchEvidence(request.toolUseId, this.db, this.sessionDir, this.pinnedSessionId, this.gitProbe);
      if (!evidenceResult.ok) {
        onEvent({ kind: 'error', runId, code: 'EVIDENCE_INCOMPLETE', message: evidenceResult.missing });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: evidenceResult.missing, findings: [], tests: [], limitations: [evidenceResult.missing] };
      }

      onEvent({ kind: 'status', runId, phase: 'creating-snapshot' });
      const snapshot = await buildVerificationSnapshot(evidenceResult.evidence);
      dispose = snapshot.dispose;

      onEvent({ kind: 'status', runId, phase: 'checking-auth' });
      client.connect();
      await client.initialize();
      await client.authenticate();
      const status = await client.authenticationStatus();
      if (!isAllowedAuthStatus(status)) {
        const message = `Codex authentication is not subscription-only (status: ${status}); refusing to run.`;
        onEvent({ kind: 'error', runId, code: 'BILLING_MODE_BLOCKED', message });
        return { schemaVersion: 1, verdict: 'inconclusive', confidence: 0, summary: message, findings: [], tests: [], limitations: [message] };
      }

      onEvent({ kind: 'status', runId, phase: 'verifying' });
      const prompt = buildVerificationPrompt(evidenceResult.evidence);
      const raw = await this.promptWithTimeout(client, snapshot.snapshotDir, prompt, RUN_TIMEOUT_MS);
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
    if (this.activeRunId !== runId || !this.activeClient) return;
    await this.activeClient.dispose();
  }
}
