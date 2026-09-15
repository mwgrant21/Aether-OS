/** Display-only runtime state. These labels never authorize bridge operations. */
export interface CommunicationSessionStatus {
  readonly instanceLabel: string;
  readonly sessionLabel: string | null;
  readonly client: 'unknown' | 'starting' | 'running' | 'exited' | 'failed';
  /** Current launch authority, independent of retained display evidence. */
  readonly connected: boolean;
  /** Positive current-prompt evidence only; unknown does not mean input-ready. */
  readonly prompt: 'unknown' | 'folder-trust';
}

export function isCommunicationPrompt(value: unknown): value is CommunicationSessionStatus['prompt'] {
  return value === 'unknown' || value === 'folder-trust';
}
export function isCommunicationClient(value: unknown): value is CommunicationSessionStatus['client'] {
  return typeof value === 'string' && ['unknown', 'starting', 'running', 'exited', 'failed'].includes(value);
}

/** Explicit allowlist: never copy terminal text or main-only launch credentials. */
export function projectCommunicationSessionStatus(value: unknown): CommunicationSessionStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.instanceLabel !== 'string' || !/^Instance [a-f0-9]{16}$/.test(raw.instanceLabel)
    || !(raw.sessionLabel === null || (typeof raw.sessionLabel === 'string'
      && /^Session [1-9][0-9]{0,15}$/.test(raw.sessionLabel)
      && Number.isSafeInteger(Number(raw.sessionLabel.slice(8)))))
    || !isCommunicationPrompt(raw.prompt)
    || !isCommunicationClient(raw.client)
    || typeof raw.connected !== 'boolean'
    || (raw.sessionLabel === null && (raw.prompt !== 'unknown' || raw.client !== 'unknown' || raw.connected))
    || (!raw.connected && raw.prompt !== 'unknown')) return null;
  return { instanceLabel: raw.instanceLabel, sessionLabel: raw.sessionLabel, prompt: raw.prompt,
    client: raw.client as CommunicationSessionStatus['client'], connected: raw.connected };
}
