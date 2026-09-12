import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lifecycle from '../../src/shared/communicationLifecycle';
import { COMMUNICATION_LIMITS as L } from '../../src/shared/communicationTypes';
import type { AskCodexInput, CommunicationErrorV1, CommunicationLaunch, CommunicationMetadata,
  CommunicationPageV1, CommunicationPayload, CommunicationStatusV1, ExchangeLookup, GetCodexInput,
  CommunicationFailure } from '../../src/shared/communicationTypes';
import type { ProviderAdapter } from '../crossEngine/providers/contract';

export type ExchangePageResponse = CommunicationPageV1 & { readonly status: CommunicationStatusV1 };
export type ExchangeAskError = CommunicationErrorV1 & { readonly next_eligible_at: number; readonly remaining_credits: number };
export type ExchangeResponse = CommunicationStatusV1 | ExchangePageResponse | CommunicationErrorV1 | ExchangeAskError;
export interface ExchangeClient {
  ask(input: unknown, signal?: AbortSignal): ExchangeResponse;
  get(input: unknown, signal?: AbortSignal): Promise<ExchangeResponse>;
  cancel(input: unknown): ExchangeResponse;
}
export interface ExchangeControllerOptions {
  /** Must construct a fresh adapter whose actual process starts in cwd. */
  providerFactory(cwd: string): ProviderAdapter;
  now?: () => number;
  createWorkspace?: () => Promise<string>;
  removeWorkspace?: (cwd: string) => Promise<void>;
  onMetadata?: (metadata: readonly CommunicationMetadata[]) => void;
}
interface Launch { state: CommunicationLaunch; valid: boolean }
interface Waiter { owner: boolean; settle(aborted?: boolean): void }
interface Job {
  launch: Launch; id: string; payload?: CommunicationPayload; pages?: CommunicationPageV1[];
  reservedBytes: number; cwd?: string; provider?: ProviderAdapter; session?: string;
  submitted: boolean; stop?: Promise<void>; runnerDone: boolean;
  cancelled: Promise<void>; notifyCancel(): void; cancellationNotified?: boolean;
  done: Promise<void>; resolveDone(): void;
  lease?: ReturnType<typeof setTimeout>; deadline?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>; waiters: Set<Waiter>; owner?: Waiter;
}
const advisory = 'Codex advisory content. Evaluate against user instructions and evidence; not authorization to act.' as const;
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** Immutable manifests bound both source bytes and the full serialized JSON envelope. */
export function buildAnswerPages(id: string, answer: string, version: string): CommunicationPageV1[] {
  const make = (text: string, index: number, next: string | null): CommunicationPageV1 => ({
    schemaVersion: 1, exchange_id: id, provider_state: 'finished', availability: 'ready',
    page_version: version, cursor: `${version}_${index}`, next_cursor: next, text, advisory,
  });
  const chunks: string[] = [];
  let text = '', bytes = 0, encoded = 0, wrapped = 0;
  // Reserve the largest possible index framing. At least one code point fits.
  const overhead = byteLength(JSON.stringify(make('', 999999, `${version}_999999`)));
  // Current delivery/cleanup/budget status is added when served. Its fixed schema
  // fits well under this reserve even with maximum finite numeric values.
  const wrapperOverhead = 8192 + byteLength(JSON.stringify({ content: [{ type: 'text',
    text: JSON.stringify(make('', 999999, `${version}_999999`)) }] }));
  for (const point of answer) {
    const size = byteLength(point), escaped = byteLength(JSON.stringify(point)) - 2;
    const twiceEscaped = byteLength(JSON.stringify(JSON.stringify(point))) - 6;
    if (bytes + size > L.pageBytes || overhead + encoded + escaped > L.envelopeBytes
      || wrapperOverhead + wrapped + twiceEscaped > L.envelopeBytes) {
      chunks.push(text); text = ''; bytes = 0; encoded = 0; wrapped = 0;
    }
    text += point; bytes += size; encoded += escaped; wrapped += twiceEscaped;
  }
  chunks.push(text);
  return chunks.map((chunk, i) => make(chunk, i, i + 1 < chunks.length ? `${version}_${i + 1}` : null));
}

/** Main-process authority. Only its scoped client facade crosses the authenticated pipe.
 * No client method accepts a launch identity, grants credits, or enables the bridge. */
export class ExchangeController {
  private enabled = false;
  private current?: Launch;
  private readonly launches = new Set<Launch>();
  private readonly jobs = new Map<string, Job>();
  private active?: Job;
  private readonly now: () => number;
  constructor(private readonly options: ExchangeControllerOptions) { this.now = options.now ?? Date.now; }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      for (const launch of this.launches) launch.valid = false;
      for (const job of this.jobs.values()) { this.requestStop(job, 'CANCELLED'); this.erase(job); }
      this.current = undefined;
      this.emit();
    }
  }
  openLaunch(): ExchangeClient {
    if (this.current) this.disconnect();
    const launch: Launch = { state: lifecycle.createCommunicationLaunch(randomUUID()), valid: this.enabled };
    this.launches.add(launch); this.current = launch;
    return Object.freeze({
      ask: (input: unknown, signal?: AbortSignal) => this.ask(launch, input, signal),
      get: (input: unknown, signal?: AbortSignal) => this.get(launch, input, signal),
      cancel: (input: unknown) => this.cancel(launch, input),
    });
  }
  disconnect(): void {
    if (!this.current) return;
    this.current.valid = false;
    this.current.state = lifecycle.setCommunicationClientConnected(this.current.state, false);
    for (const job of this.jobs.values()) if (job.launch === this.current) this.requestStop(job, 'CANCELLED');
    this.emit();
  }
  grantCredits(confirmationId: string): void {
    if (this.enabled && this.current?.valid) {
      this.current.state = lifecycle.grantCommunicationCredits(this.current.state, confirmationId); this.emit();
    }
  }
  metadata(): readonly CommunicationMetadata[] {
    return [...this.jobs.values()].filter(j => j.payload).map(j => structuredClone(this.exchange(j).metadata));
  }
  readPayload(id: string): CommunicationPayload | undefined {
    this.expireContent();
    const payload = this.jobs.get(id)?.payload;
    return payload ? { ...payload } : undefined;
  }
  clear(id: string): void {
    const job = this.jobs.get(id);
    if (job) { this.requestStop(job, 'CANCELLED'); this.erase(job); this.emit(); }
  }
  cancelFromOperator(id: string): void { const job = this.jobs.get(id); if (job) this.requestStop(job, 'CANCELLED'); }
  /** U5 supplies the shutdown deadline; rejection is never process-exit proof. */
  async dispose(): Promise<void> {
    this.setEnabled(false);
    const active = this.active;
    if (active) {
      await active.done;
      if (!this.exchange(active).cleanupConfirmed) throw new Error('CLEANUP_FAILED');
    }
  }
  private exchange(job: Job) { return lifecycle.lookupCommunication(job.launch.state, { exchange_id: job.id })!; }
  private emit() { try { this.options.onMetadata?.(this.metadata()); } catch { /* UI failure cannot affect authority. */ } }
  private gate(launch: Launch): CommunicationErrorV1 | undefined {
    return !this.enabled ? lifecycle.communicationError('DISABLED') : !launch.valid
      ? lifecycle.communicationError('NOT_CONNECTED') : undefined;
  }
  private ask(launch: Launch, value: unknown, signal?: AbortSignal): ExchangeResponse {
    const rejection = (error: CommunicationErrorV1): ExchangeAskError => ({ ...error,
      next_eligible_at: Math.max(this.now(), launch.state.cooldownUntil),
      remaining_credits: lifecycle.communicationCredits(launch.state).remaining });
    const gate = this.gate(launch); if (gate) return rejection(gate);
    this.expireContent();
    const invalid = lifecycle.validateAskCodex(value);
    if (invalid) { launch.state = lifecycle.rejectCommunicationAsk(launch.state, invalid, this.now()); return rejection(lifecycle.communicationError(invalid)); }
    const input = value as AskCodexInput;
    // Page text is retained alongside the authoritative answer. Reserve both plus
    // bounded manifest framing before admission; never evict a live answer.
    const reservation = byteLength(input.question) + byteLength(input.context ?? '') + 2 * L.answerBytes + 16 * 1024;
    const retained = [...this.jobs.values()].filter(j => j.payload);
    const capacity = this.active ? 'BUSY' : retained.length >= 20
      || retained.reduce((n, j) => n + j.reservedBytes, 0) + reservation > 2 * 1024 * 1024 ? 'RETENTION_FULL' : null;
    const result = lifecycle.acceptCommunicationAsk(launch.state, input, { exchangeId: randomUUID(),
      fingerprint: createHash('sha256').update(JSON.stringify([input.question, input.context ?? ''])).digest('hex'),
      now: this.now(), gate: null, capacity });
    launch.state = result.state;
    if (result.error) return rejection(lifecycle.communicationError(result.error));
    const id = result.exchangeId!;
    if (!result.duplicate) {
      let notifyCancel!: () => void;
      const cancelled = new Promise<void>(resolve => { notifyCancel = resolve; });
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const job: Job = { launch, id, payload: { question: input.question, context: input.context, answer: '' },
        reservedBytes: reservation, submitted: false, runnerDone: false, waiters: new Set(), cancelled, notifyCancel, done, resolveDone };
      this.jobs.set(id, job); this.active = job; this.arm(job);
      // The accepted reservation and global slot are visible before any provider work.
      queueMicrotask(() => { void this.run(job); });
    }
    const job = this.jobs.get(id)!;
    if (signal?.aborted) this.requestStop(job, 'CANCELLED');
    this.emit();
    return lifecycle.communicationStatus(launch.state, id, this.now())!;
  }
  private lookup(launch: Launch, value: unknown, get = false): Job | CommunicationErrorV1 {
    const gate = this.gate(launch); if (gate) return gate;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return lifecycle.communicationError('INVALID_INPUT');
    const input = value as Record<string, unknown>;
    const allowed = get ? ['exchange_id', 'request_key', 'cursor', 'wait_ms'] : ['exchange_id', 'request_key'];
    if (Object.keys(input).some(k => !allowed.includes(k))
      || ('exchange_id' in input) === ('request_key' in input)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(String(input.exchange_id ?? input.request_key))
      || typeof (input.exchange_id ?? input.request_key) !== 'string'
      || (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 128))
      || (input.wait_ms !== undefined && (!Number.isInteger(input.wait_ms) || Number(input.wait_ms) < 1000 || Number(input.wait_ms) > 60_000)))
      return lifecycle.communicationError('INVALID_INPUT');
    const exchange = lifecycle.lookupCommunication(launch.state, input as ExchangeLookup);
    const job = exchange && this.jobs.get(exchange.metadata.exchangeId);
    return job ?? lifecycle.communicationError('UNKNOWN_EXCHANGE');
  }
  private cancel(launch: Launch, input: unknown): ExchangeResponse {
    const job = this.lookup(launch, input); if ('code' in job) return job;
    this.requestStop(job, 'CANCELLED');
    return lifecycle.communicationStatus(launch.state, job.id, this.now())!;
  }
  private async get(launch: Launch, value: unknown, signal?: AbortSignal): Promise<ExchangeResponse> {
    this.expireContent();
    const job = this.lookup(launch, value, true); if ('code' in job) return job;
    const input = value as GetCodexInput;
    if (signal?.aborted) return lifecycle.communicationError('CANCELLED');
    this.checkActive(job);
    if (this.exchange(job).metadata.finishedAt !== null || !job.payload) return this.response(job, input.cursor);
    if (input.cursor !== undefined) return lifecycle.communicationError('INVALID_INPUT');
    if (job.waiters.size >= L.maxWaiters) return lifecycle.communicationError('READ_CAPACITY');
    return new Promise(resolve => {
      const owner = !job.owner;
      const waiter: Waiter = { owner, settle: aborted => {
        if (!job.waiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (job.owner === waiter) job.owner = undefined;
        if (!aborted && owner && this.exchange(job).metadata.finishedAt === null) {
          launch.state = lifecycle.renewCommunicationLease(launch.state, job.id, this.now(), 'owner-pending-return');
          this.arm(job);
        }
        resolve(aborted ? lifecycle.communicationError('CANCELLED') : this.response(job));
      } };
      const abort = () => waiter.settle(true);
      const timer = setTimeout(() => { this.checkActive(job); waiter.settle(); },
        Math.max(0, Math.min(input.wait_ms ?? 45_000, this.exchange(job).metadata.deadlineAt - this.now())));
      job.waiters.add(waiter);
      if (owner) { job.owner = waiter; launch.state = lifecycle.renewCommunicationLease(launch.state, job.id, this.now(), 'owner-admitted'); this.arm(job); }
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private response(job: Job, cursor?: string): ExchangeResponse {
    this.expireContent();
    const exchange = this.exchange(job);
    if (!job.payload || exchange.metadata.delivery.availability === 'expired') return lifecycle.communicationError('EXPIRED');
    if (exchange.metadata.providerState === 'finished' && job.pages) {
      const index = cursor === undefined ? 0 : job.pages.findIndex(p => p.cursor === cursor);
      if (index < 0) return lifecycle.communicationError('INVALID_INPUT');
      job.launch.state = lifecycle.recordCommunicationPageServed(job.launch.state, job.id, exchange.pageVersion!, index);
      const page = { ...job.pages[index], status: lifecycle.communicationStatus(job.launch.state, job.id, this.now())! };
      if (byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(page) }] })) > L.envelopeBytes)
        return lifecycle.communicationError('OUTPUT_LIMIT');
      this.emit(); return page;
    }
    return lifecycle.communicationStatus(job.launch.state, job.id, this.now())!;
  }
  private wake(job: Job) { for (const waiter of [...job.waiters]) waiter.settle(); }
  private arm(job: Job): void {
    clearTimeout(job.lease); clearTimeout(job.deadline);
    const e = this.exchange(job);
    if (e.metadata.finishedAt !== null || e.cancellationReason) return;
    job.lease = setTimeout(() => this.checkActive(job), Math.max(0, e.metadata.leaseExpiresAt - this.now()));
    job.deadline = setTimeout(() => this.checkActive(job), Math.max(0, e.metadata.deadlineAt - this.now()));
  }
  private checkActive(job: Job): boolean {
    job.launch.state = lifecycle.expireActiveCommunication(job.launch.state, job.id, this.now());
    const e = this.exchange(job);
    if (e.cancellationReason) this.requestStop(job, e.cancellationReason);
    return e.metadata.finishedAt === null && !e.cancellationReason;
  }
  private requestStop(job: Job, reason: CommunicationFailure): void {
    if (this.exchange(job).metadata.finishedAt !== null) return;
    const first = !job.cancellationNotified;
    job.cancellationNotified = true;
    job.launch.state = lifecycle.cancelCommunication(job.launch.state, job.id, reason);
    clearTimeout(job.lease); clearTimeout(job.deadline);
    if (first) this.wake(job);
    job.notifyCancel();
    if (job.provider && !job.stop) {
      // Disposal is authoritative; an interrupt acknowledgement is not exit proof.
      if (job.session) void job.provider.cancel(job.session).catch(() => {});
      job.stop = Promise.resolve().then(() => job.provider!.dispose());
      void job.stop.catch(() => {});
    }
    this.emit();
  }
  private async run(job: Job): Promise<void> {
    const change = (fn: (state: CommunicationLaunch) => CommunicationLaunch) => { job.launch.state = fn(job.launch.state); this.emit(); };
    const whileActive = <T>(operation: Promise<T>) => Promise.race([operation,
      job.cancelled.then(() => { throw new Error('Cancelled'); })]);
    try {
      if (!this.checkActive(job)) return;
      change(s => lifecycle.advanceCommunicationProvider(s, job.id, 'preparing'));
      job.cwd = await (this.options.createWorkspace?.() ?? mkdtemp(join(tmpdir(), 'aether-exchange-')));
      if (!this.checkActive(job)) return;
      job.provider = this.options.providerFactory(job.cwd);
      if (!this.checkActive(job)) return;
      await whileActive(job.provider.connect());
      if (!this.checkActive(job)) return;
      const health = await whileActive(job.provider.health());
      if (!this.checkActive(job)) return;
      if (!health.ready || health.authMode !== 'subscription') throw new Error('Provider unavailable');
      job.session = await whileActive(job.provider.newSession({ cwd: job.cwd }));
      if (!this.checkActive(job)) return;
      change(s => lifecycle.advanceCommunicationProvider(s, job.id, 'waiting'));
      change(s => lifecycle.beginCommunicationSubmission(s, job.id));
      job.submitted = true;
      const result = await whileActive(job.provider.sendTurn({ sessionId: job.session,
        text: JSON.stringify({ question: job.payload!.question, context: job.payload!.context }),
        timeoutMs: Math.max(1, this.exchange(job).metadata.deadlineAt - this.now()) }, event => {
        if (event.kind !== 'message-chunk' || !this.checkActive(job) || !job.payload) return;
        // Providers may split a UTF-16 surrogate pair across delta boundaries.
        const deltaBytes = byteLength(job.payload.answer + event.text) - byteLength(job.payload.answer);
        change(s => lifecycle.observeCommunicationOutput(s, job.id, deltaBytes, this.now()));
        if (this.exchange(job).cancellationReason) { this.requestStop(job, 'OUTPUT_LIMIT'); return; }
        job.payload = { ...job.payload, answer: job.payload.answer + event.text }; this.emit();
      }));
      if (!this.checkActive(job)) return;
      if (byteLength(result.text) > L.answerBytes) { this.requestStop(job, 'OUTPUT_LIMIT'); return; }
      if (job.payload) job.payload = { ...job.payload, answer: result.text };
      change(s => lifecycle.finishCommunication(s, job.id, this.now(), {
        outcome: result.stopReason === 'completed' ? 'finished' : result.stopReason === 'timeout' ? 'TIMEOUT' : 'PROVIDER_FAILED',
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      }));
      if (this.exchange(job).metadata.providerState === 'finished' && job.payload) {
        job.pages = buildAnswerPages(job.id, result.text, randomUUID());
        change(s => lifecycle.defineCommunicationPages(s, job.id, job.pages![0].page_version, job.pages!.map(p => p.cursor)));
      }
    } catch { /* Safe terminal code only: raw provider errors never enter retained state. */ }
    finally {
      if (!job.submitted) change(s => lifecycle.releaseUnsubmittedCommunication(s, job.id, 'confirmed-not-submitted'));
      change(s => lifecycle.finishCommunication(s, job.id, this.now(), { outcome: 'PROVIDER_FAILED' }));
      clearTimeout(job.lease); clearTimeout(job.deadline); this.wake(job);
      const expiry = this.exchange(job).metadata.contentExpiresAt;
      if (expiry !== null && job.payload) job.expiry = setTimeout(() => { this.expireContent(); this.emit(); }, Math.max(0, expiry - this.now()));
      try {
        if (job.provider) await (job.stop ?? job.provider.dispose());
        if (job.cwd) await (this.options.removeWorkspace?.(job.cwd) ?? rm(job.cwd, { recursive: true, force: true }));
        change(s => lifecycle.confirmCommunicationCleanup(s, job.id));
        if (this.active === job) this.active = undefined;
      } catch { change(s => lifecycle.failCommunicationCleanup(s, job.id)); }
      job.runnerDone = true; job.resolveDone(); this.emit();
    }
  }
  private erase(job: Job): void {
    job.payload = undefined; job.pages = undefined; job.reservedBytes = 0; clearTimeout(job.expiry);
  }
  private expireContent(): void {
    for (const launch of this.launches) launch.state = lifecycle.expireCommunicationContent(launch.state, this.now());
    for (const job of this.jobs.values()) if (this.exchange(job).metadata.delivery.availability === 'expired') this.erase(job);
    // A live launch retains lightweight deduplication tombstones. Ended launches
    // need them only while their content or actual process cleanup remains owned.
    for (const job of this.jobs.values()) if (!job.launch.valid && !job.payload && job.runnerDone
      && this.exchange(job).cleanupConfirmed && this.active !== job) this.jobs.delete(job.id);
    for (const launch of this.launches) if (!launch.valid && ![...this.jobs.values()].some(j => j.launch === launch))
      this.launches.delete(launch);
  }
}
