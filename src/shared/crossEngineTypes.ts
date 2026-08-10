export type CodexAuthStatus = 'chat-gpt' | 'api-key' | 'gateway' | 'unauthenticated' | 'unknown';

export type VerifierStatus =
  | 'disabled' | 'not-installed' | 'sign-in-required' | 'ready-subscription'
  | 'blocked-billing-mode' | 'version-unsupported' | 'error';

export type VerdictKind = 'supported' | 'contradicted' | 'inconclusive';

export interface VerificationFinding {
  severity: 'info' | 'warning' | 'error';
  claim: string;
  evidence: string;
  file: string | null;
  line: number | null;
}

export interface VerificationTest {
  command: string;
  outcome: 'passed' | 'failed' | 'not-run';
  detail: string;
}

export interface VerificationResultV1 {
  schemaVersion: 1;
  verdict: VerdictKind;
  confidence: number;
  summary: string;
  findings: VerificationFinding[];
  tests: VerificationTest[];
  limitations: string[];
}

export interface VerificationRequest {
  toolUseId: string;
}

export type VerificationEvent =
  | { kind: 'status'; runId: string; phase: 'preparing-evidence' | 'creating-snapshot' | 'checking-auth' | 'verifying' | 'running-tests' }
  | { kind: 'result'; runId: string; result: VerificationResultV1 }
  | { kind: 'error'; runId: string; code: string; message: string }
  | { kind: 'cancelled'; runId: string };
