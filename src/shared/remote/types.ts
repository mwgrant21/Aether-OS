// Renderer-safe contract for mobile remote access (no node imports).
export const REMOTE_PORT = 47821;
export const REMOTE_BODY_CAP = 4000; // chars per bubble body after masking
export const REMOTE_LABEL_CAP = 60;
export const REMOTE_REPLAY_BYTES = 64 * 1024; // Matt answer 7
export const REMOTE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Open Call 1
export const REMOTE_MAX_SESSIONS = 5;
export const REMOTE_MAX_CLIENTS = 3;
export type RemoteState = 'off' | 'on' | 'unavailable';
export type RemoteUnavailableReason = 'no-tailnet-address' | 'port-in-use' | 'error';
export interface RemoteSessionInfo {
  ref: string; // first 12 hex chars of the stored hash; display + revoke-one key only
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenMs: number;
  peer?: string; // device scope only: tailnet address the token is bound to
}
export interface RemoteStatus {
  state: RemoteState;
  reason: RemoteUnavailableReason | null; // only when state === 'unavailable'
  address: string | null; // "100.x.y.z:47821" while on
  clients: number; // live WebSocket count (drives the top-bar chip)
  sessions: RemoteSessionInfo[]; // paired, unexpired; present even when state is 'off'
  pairingActive: boolean; // an unexpired unused code exists (the code is NOT here)
  following: boolean; // a pinned Claude session transcript is being followed
  notice: string | null; // fixed text, e.g. "Revoke not saved to disk yet"; null when nothing to report
}
export type PairingResult =
  | { ok: true; url: string; code: string; qrSvg: string; expiresAtMs: number }
  | { ok: false; reason: 'not-enabled' };

// ---- Phone control (mobile V1). Mirrors protocol/mobile-protocol.json; pinned by mobileProtocol.test.ts.
export const CONTROL_PORT = 47821;
export const CONTROL_PATH = '/ctl';
export const CONTROL_PAIR_PATH = '/api/device/pair';
export const CONTROL_CODE_LENGTH = 8;
export const CONTROL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CONTROL_CODE_TTL_MS = 5 * 60 * 1000;
export const CONTROL_MAX_CODE_FAILURES = 5;
export const CONTROL_PAIR_BODY_CAP = 1024;
export const CONTROL_PAIR_CONFIRM_TIMEOUT_MS = 60 * 1000;
export const CONTROL_SLIDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONTROL_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const CONTROL_HELLO_TIMEOUT_MS = 5000;
export const CONTROL_MAX_SOCKETS = 2;
export const CONTROL_MAX_DEVICES = 1; // Matt, 2026-10-22: one paired app; replacing it is T2/T6 policy; not in the JSON
export const CONTROL_CTL_MAX_PAYLOAD = 64 * 1024;
export const CONTROL_RECHECK_MS = 10000;
export const CONTROL_INPUT_MAX_BYTES = 8192;
export const CONTROL_INPUT_MAX_BYTES_PER_SEC = 256 * 1024;
export const CONTROL_INPUT_MAX_FRAMES_PER_SEC = 100;
export const CONTROL_ACK_COALESCE_MS = 30;
export const CONTROL_PROOF_LABEL = 'server';
export const CONTROL_PROOF_SUFFIX = '/ctl';
export const CONTROL_MESSAGE_TYPES = {
  phoneToTitan: ['hello', 'attach', 'detach', 'in', 'thread.attach', 'thread.detach', 'ledger.attach', 'ledger.detach'],
  titanToPhone: ['welcome', 'bye', 'snap', 'out', 'size', 'state', 'ack', 'nak', 'thread.snap', 'thread.ev', 'thread.state', 'prompt', 'prompt.closed', 'ledger.snap'],
} as const;
export const CONTROL_NAK_REASONS = ['not-running', 'typing-off'] as const;
export type NakReason = (typeof CONTROL_NAK_REASONS)[number];
export const CONTROL_BYE_REASONS = [
  'revoked',
  'disabled',
  'expired',
  'superseded',
  'policy',
  'slow-consumer',
  'rate-limit',
] as const;
export const CONTROL_PAIR_STATUS = { ok: 200, badCode: 401, declined: 403, burned: 429, busy: 409 } as const;

export interface ControlSocket {
  send(text: string): void; // no-op after close
  close(code: number): void;
  bufferedBytes(): number;
  onMessage(cb: (text: string) => void): void; // text frames only; the server closes 1003 on a binary frame
  onClose(cb: () => void): void;
}
export interface ControlIdentity {
  ref: string; // first 12 hex of the stored hash
  expiresAtMs: number;
  proofFor(nonce: string): string;
}
export type ControlPairResult =
  | { status: 200; token: string; expiresAtMs: number }
  | { status: 400 | 401 | 403 | 429 | 409 };
export type AuthRejectReason = 'no-device' | 'no-bearer' | 'unknown' | 'expired' | 'peer-mismatch' | 'error';
export interface ControlPort {
  maxSockets: number;
  authenticate(
    authorization: string | undefined,
    peer: string | undefined,
    o?: { touch?: boolean; onReject?: (reason: AuthRejectReason) => void },
  ): ControlIdentity | null;
  pair(code: unknown, peer: string | undefined): Promise<ControlPairResult>;
  open(socket: ControlSocket, identity: ControlIdentity): void;
}
export interface ListenerPort {
  acquire(): Promise<{ ok: true; address: string } | { ok: false; reason: RemoteUnavailableReason }>;
  release(): Promise<void>;
  address(): string | null; // "100.x.y.z:47821" while the shared listener is up
  closeControlClients(reason: 'revoked' | 'disabled'): void;
  recheckControl(): void;
  onControlClients(cb: (n: number) => void): void;
}
export interface ControlStatus {
  state: RemoteState;
  reason: RemoteUnavailableReason | null;
  address: string | null;
  connected: number;
  devices: RemoteSessionInfo[];
  pairingActive: boolean;
  reenableAtLaunch: boolean;
  phoneTyping: boolean;
  notice: string | null;
  /** Terminal slots the connected phone is attached to, in TERMINAL_SLOTS order. Absent or empty = none. Optional so existing literals stay valid. */
  phoneSlots?: readonly TerminalSlotId[];
}
export type ControlPairingResult =
  | { ok: true; uri: string; code: string; qrSvg: string; expiresAtMs: number }
  | { ok: false; reason: 'not-enabled' };

// ---- Terminal slots (mobile V2). Pinned by mobileProtocol.test.ts against protocol/mobile-protocol.json `terminals`.
export const TERMINAL_SLOTS = [
  { s: 'claude', label: 'Terminal' }, { s: 'terminal2', label: 'Terminal 2' }, { s: 'codex', label: 'Codex' },
] as const;
export type TerminalSlotId = (typeof TERMINAL_SLOTS)[number]['s'];
export type TerminalSlotState = 'not-started' | 'running' | 'exited';
export const TERMINAL_CHUNK_MAX_BYTES = 16 * 1024;          // raw, per out frame
export const TERMINAL_RING_BYTES = 256 * 1024;              // JSON-escaped length, per slot
export const TERMINAL_SNAPSHOT_BYTES = 256 * 1024;          // JSON-escaped length of snap.d
export const TERMINAL_SNAPSHOT_SCROLLBACK_LINES = 1000;
export const TERMINAL_MIRROR_SCROLLBACK_LINES = 2000;
export interface TerminalInfo { s: TerminalSlotId; label: string; state: TerminalSlotState; cols: number; rows: number; q: number }
export interface TerminalTap {                               // callbacks are delivered in order, never re-entrantly
  snap(e: { q: number; cols: number; rows: number; d: string }): void;   // replaces the phone terminal content
  out(e: { q: number; d: string }): void;                                // q strictly +1 after the last snap/out
  size(e: { cols: number; rows: number }): void;
}
export interface TerminalAttachment { detach(): void }
/** Narrow write handle for the input router (the only phone-to-pty write site). true = written to a running pty. */
export interface TerminalWritePort { write(s: TerminalSlotId, d: string): boolean }
export type InputResult =
  | { kind: 'applied' | 'duplicate'; ack: number }   // ack = the cumulative cseq to report
  | { kind: 'rejected'; c: number; reason: NakReason }   // cseq consumed, nothing written; the gateway answers with a nak
  | { kind: 'violation'; why: string }
  | { kind: 'rate-limit' };
export interface InputSession {
  input(s: TerminalSlotId, c: number, d: string): InputResult;
  applied(): Record<string, number>;                  // { slot: last applied cseq } for this device + epoch
  close(): void;
}
export interface InputPort { open(ref: string, epoch: string): InputSession }
export interface TerminalReadPort {
  list(): TerminalInfo[];
  attach(s: TerminalSlotId, lastQ: number | null, tap: TerminalTap): TerminalAttachment;   // snapshot (async inside) or exact resume
  onState(cb: (e: { s: TerminalSlotId; state: TerminalSlotState }) => void): () => void;  // returns unsubscribe
  retain(): () => void;                                      // refcounted; returns release (idempotent)
}

// ---- Phone thread (slice 1). Pinned by mobileProtocol.test.ts against protocol/mobile-protocol.json `thread`.
export const THREAD_SNAPSHOT_MAX_EVENTS = 200;
export const THREAD_TEXT_CAP = 8000;                        // chars; longer text is cut and `truncated` is set
export const THREAD_TARGET_CAP = 160;
export const THREAD_SNAPSHOT_MAX_BYTES = 200 * 1024;        // oldest events are dropped until the snap fits
export const PROMPT_SUMMARY_CAP = 1200;
export const THREAD_WORKING_STALE_MS = 120000;
export type ThreadSlotId = 'claude';
export type ThreadEvent =
  | { k: 'user'; id: string; at: number; text: string; truncated: boolean }
  | { k: 'claude'; id: string; at: number; text: string; truncated: boolean }
  | { k: 'tool'; id: string; at: number; name: string; target: string | null; add: number | null; del: number | null };
export interface ThreadTap {                                 // callbacks are delivered in order, never re-entrantly
  snap(e: { q: number; attached: boolean; working: boolean; workingSinceMs: number | null; events: readonly ThreadEvent[] }): void;
  events(e: { q: number; events: readonly ThreadEvent[] }): void;
  state(e: { q: number; working: boolean; workingSinceMs: number | null }): void;
}
/** attach() delivers `snap` synchronously, before it returns. */
export interface ThreadReadPort { attach(s: ThreadSlotId, tap: ThreadTap): { detach(): void } }
export const LEDGER_TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const; // must equal Object.keys(PRICING_PER_MILLION_TOKENS); protocol.test.ts pins it
export type LedgerTier = (typeof LEDGER_TIERS)[number];
export interface LedgerWire {
  computedAtMs: number;
  total: { usd: number; input: number; output: number; cacheCreation: number; cacheRead: number };
  tiers: readonly LedgerTier[];
  rollups: { today: number | null; week: number | null; month: number | null };
  cache: { readTokens: number; wouldHaveUsd: number; actualUsd: number; savedUsd: number; hitRate: number };
}
export interface LedgerTap { snap(l: LedgerWire | null): void } // delivered in order, never re-entrantly
/** attach() delivers the current state to tap.snap synchronously before it returns, then every publish. */
export interface LedgerReadPort { attach(tap: LedgerTap): { detach(): void } }
export const CONTROL_PROMPT_CLOSE_REASONS = ['answered-desktop', 'timeout'] as const;
export type PromptCloseReason = (typeof CONTROL_PROMPT_CLOSE_REASONS)[number];
export interface PromptInfo { id: string; tool: string; risk: 'LOW' | 'MED' | 'HIGH'; summary: string; ttlMs: number }
export interface PromptTap {
  opened(p: PromptInfo): void;
  closed(e: { id: string; reason: PromptCloseReason }): void;
}
/** attach() replays every pending prompt as `opened` synchronously, then forwards live opened/closed. */
export interface PromptReadPort { attach(tap: PromptTap): { detach(): void } }
