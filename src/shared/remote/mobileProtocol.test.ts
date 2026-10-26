import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as T from './types'
import * as TH from './threadTypes'

const spec = JSON.parse(readFileSync(resolve(__dirname, '../../../protocol/mobile-protocol.json'), 'utf8'))

describe('mobile-protocol.json matches the TypeScript constants', () => {
  it('port, paths, scheme', () => {
    expect(spec.v).toBe(1)
    expect(spec.port).toBe(T.CONTROL_PORT)
    expect(spec.port).toBe(T.REMOTE_PORT)
    expect(spec.paths).toEqual({ ctl: T.CONTROL_PATH, pair: T.CONTROL_PAIR_PATH })
    expect(spec.auth.scheme).toBe('Bearer')
  })
  it('pairing', () => {
    expect(spec.pairing.codeLength).toBe(T.CONTROL_CODE_LENGTH)
    expect(spec.pairing.codeAlphabet).toBe(T.CONTROL_CODE_ALPHABET)
    expect(spec.pairing.codeTtlMs).toBe(T.CONTROL_CODE_TTL_MS)
    expect(spec.pairing.maxCodeFailures).toBe(T.CONTROL_MAX_CODE_FAILURES)
    expect(spec.pairing.bodyCapBytes).toBe(T.CONTROL_PAIR_BODY_CAP)
    expect(spec.pairing.confirmTimeoutMs).toBe(T.CONTROL_PAIR_CONFIRM_TIMEOUT_MS)
  })
  it('token lifetimes and size', () => {
    expect(spec.token.slidingTtlMs).toBe(T.CONTROL_SLIDING_TTL_MS)
    expect(spec.token.absoluteTtlMs).toBe(T.CONTROL_ABSOLUTE_TTL_MS)
    expect(spec.token.bytes).toBe(32)
    expect(spec.token.encoding).toBe('base64url')
  })
  it('limits', () => {
    expect(spec.limits).toEqual({
      helloTimeoutMs: T.CONTROL_HELLO_TIMEOUT_MS,
      maxControlSockets: T.CONTROL_MAX_SOCKETS,
      ctlMaxPayloadBytes: T.CONTROL_CTL_MAX_PAYLOAD,
      recheckMs: T.CONTROL_RECHECK_MS,
    })
  })
  it('messages, bye reasons, pair status codes', () => {
    expect(spec.messages.phoneToTitan).toEqual([...T.CONTROL_MESSAGE_TYPES.phoneToTitan])
    expect(spec.messages.titanToPhone).toEqual([...T.CONTROL_MESSAGE_TYPES.titanToPhone])
    expect(spec.messages.byeReasons).toEqual([...T.CONTROL_BYE_REASONS])
    const { successBody, ...codes } = spec.pairResponses
    expect(codes).toEqual(T.CONTROL_PAIR_STATUS)
    expect(successBody).toEqual(['token', 'expiresAtMs'])
  })
})

describe('proof known-answer vector', () => {
  const p = spec.proof
  it('uses the TS label and suffix', () => {
    expect(p.label).toBe(T.CONTROL_PROOF_LABEL)
    expect(p.suffix).toBe(T.CONTROL_PROOF_SUFFIX)
    expect(p.separator).toBe('\n')
  })
  it('tokenSha256Hex is the sha256 of the token text', () => {
    const digest = createHash('sha256').update(p.vectors.token, 'utf8').digest()
    expect(digest.toString('hex')).toBe(p.vectors.tokenSha256Hex)
  })
  it('proof is HMAC-SHA256 keyed by the raw digest bytes', () => {
    const key = createHash('sha256').update(p.vectors.token, 'utf8').digest()
    const msg = `${p.label}${p.separator}${p.vectors.nonce}${p.separator}${p.suffix}`
    expect(createHmac('sha256', key).update(msg).digest('hex')).toBe(p.vectors.proof)
    // keying with the hex text instead of the raw bytes must NOT reproduce it
    expect(createHmac('sha256', p.vectors.tokenSha256Hex).update(msg).digest('hex')).not.toBe(p.vectors.proof)
  })
})

describe('golden frames', () => {
  it('hello', () => {
    const f = JSON.parse(spec.frames.hello)
    expect(Object.keys(f)).toEqual(['t', 'v', 'app', 'epoch', 'nonce'])
    expect(spec.messages.phoneToTitan).toContain(f.t)
    expect(f.v).toBe(1)
    expect(f.epoch).toMatch(/^[0-9a-f]{16}$/)
    expect(f.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(f.nonce).toBe(spec.proof.vectors.nonce)
  })
  it('welcome', () => {
    const f = JSON.parse(spec.frames.welcome)
    expect(Object.keys(f)).toEqual(['t', 'v', 'proof', 'serverTimeMs', 'expiresAtMs', 'sessions', 'applied', 'prompts'])
    expect(spec.messages.titanToPhone).toContain(f.t)
    expect(f.proof).toBe(spec.proof.vectors.proof)
    expect(f.sessions).toEqual([])
    expect(f.applied).toEqual({})
    expect(f.prompts).toEqual([])
  })
  it('bye', () => {
    const f = JSON.parse(spec.frames.bye)
    expect(Object.keys(f)).toEqual(['t', 'reason'])
    expect(spec.messages.titanToPhone).toContain(f.t)
    expect(spec.messages.byeReasons).toContain(f.reason)
  })
})

describe('pairing code alphabet', () => {
  it('has 31 unambiguous characters', () => {
    const a: string = spec.pairing.codeAlphabet
    expect(a).toHaveLength(31)
    expect(new Set(a).size).toBe(31)
    expect(a).not.toMatch(/[0O1IL]/)
  })
})

describe('terminal frame goldens', () => {
  it('every golden t is in the right messages list', () => {
    for (const k of ['attach', 'attachResume', 'detach']) expect(spec.messages.phoneToTitan).toContain(JSON.parse(spec.frames[k]).t)
    for (const k of ['welcome', 'welcomeSessions', 'bye', 'snap', 'out', 'size', 'state']) expect(spec.messages.titanToPhone).toContain(JSON.parse(spec.frames[k]).t)
  })
  it('messages lists are exactly the declared verbs, in order', () => {
    expect(spec.messages.phoneToTitan).toEqual(['hello', 'attach', 'detach', 'tattach', 'tdetach', 'tget'])
    expect(spec.messages.titanToPhone).toEqual(['welcome', 'bye', 'snap', 'out', 'size', 'state', 'tsnap', 'tadd', 'tupd', 'tmeta', 'tdet'])
  })
  it('welcomeSessions lists the three slots in TERMINAL_SLOTS order with the six documented keys', () => {
    const f = JSON.parse(spec.frames.welcomeSessions)
    expect(f.sessions.map((x: { s: string }) => x.s)).toEqual(T.TERMINAL_SLOTS.map((x) => x.s))
    expect(f.sessions.map((x: { label: string }) => x.label)).toEqual(T.TERMINAL_SLOTS.map((x) => x.label))
    for (const x of f.sessions) {
      expect(Object.keys(x)).toEqual(['s', 'label', 'state', 'cols', 'rows', 'q'])
      expect(spec.terminals.states).toContain(x.state)
    }
  })
  it('frame key order', () => {
    expect(Object.keys(JSON.parse(spec.frames.snap))).toEqual(['t', 's', 'q', 'cols', 'rows', 'd'])
    expect(Object.keys(JSON.parse(spec.frames.out))).toEqual(['t', 's', 'q', 'd'])
    expect(Object.keys(JSON.parse(spec.frames.size))).toEqual(['t', 's', 'cols', 'rows'])
    expect(Object.keys(JSON.parse(spec.frames.state))).toEqual(['t', 's', 'state'])
  })
})

describe('terminals section', () => {
  const states = ['not-started', 'running', 'exited'] as const satisfies readonly T.TerminalSlotState[]
  // Exhaustive table: adding a TerminalSlotState member makes this fail to compile until it is listed.
  const stateTable: Record<T.TerminalSlotState, true> = { 'not-started': true, running: true, exited: true }
  it('slots equal TERMINAL_SLOTS in order with labels', () => {
    expect(spec.terminals.slots).toEqual(T.TERMINAL_SLOTS.map((x) => ({ s: x.s, label: x.label })))
  })
  it('states equal the union literals', () => {
    expect(spec.terminals.states).toEqual([...states])
    expect(Object.keys(stateTable).sort()).toEqual([...states].sort())
  })
  it('caps equal the exported constants', () => {
    expect(spec.terminals.chunkMaxBytes).toBe(T.TERMINAL_CHUNK_MAX_BYTES)
    expect(spec.terminals.ringBytes).toBe(T.TERMINAL_RING_BYTES)
    expect(spec.terminals.snapshotBytes).toBe(T.TERMINAL_SNAPSHOT_BYTES)
    expect(spec.terminals.snapshotScrollbackLines).toBe(T.TERMINAL_SNAPSHOT_SCROLLBACK_LINES)
    expect(spec.terminals.mirrorScrollbackLines).toBe(T.TERMINAL_MIRROR_SCROLLBACK_LINES)
    expect(spec.terminals.sizeUnit).toBe('json-escaped length')
  })
})

describe('threads section', () => {
  it('slots and caps equal the exported constants', () => {
    const t = spec.threads
    expect(t.slots).toEqual([...TH.THREAD_SLOTS])
    expect(t.historyEntries).toBe(TH.THREAD_HISTORY_ENTRIES)
    expect(t.snapshotBytes).toBe(TH.THREAD_SNAPSHOT_BYTES)
    expect(t.textCap).toBe(TH.THREAD_TEXT_CAP)
    expect(t.labelCap).toBe(TH.THREAD_LABEL_CAP)
    expect(t.diffInlineLines).toBe(TH.THREAD_DIFF_INLINE_LINES)
    expect(t.detailBytes).toBe(TH.THREAD_DETAIL_BYTES)
    expect(t.detailLines).toBe(TH.THREAD_DETAIL_LINES)
    expect(t.inputBytes).toBe(TH.THREAD_INPUT_BYTES)
    expect(t.inputLines).toBe(TH.THREAD_INPUT_LINES)
    expect(t.detailStoreBytes).toBe(TH.THREAD_DETAIL_STORE_BYTES)
    expect(t.pollMs).toBe(TH.THREAD_POLL_MS)
    expect(t.quietMs).toBe(TH.THREAD_QUIET_MS)
    expect(t.permClearMs).toBe(TH.THREAD_PERM_CLEAR_MS)
    expect(t.ratePerS).toBe(TH.THREAD_RATE_PER_S)
    expect(t.rateBurst).toBe(TH.THREAD_RATE_BURST)
    expect(Object.keys(t)).toHaveLength(17)
  })
  it('thread golden types sit in the right messages lists', () => {
    for (const k of ['tattach', 'tdetach', 'tget']) expect(spec.messages.phoneToTitan).toContain(JSON.parse(spec.frames[k]).t)
    for (const k of ['tsnap', 'tsnapUnavailable', 'tadd', 'tupd', 'tmeta', 'tdet', 'tdetNull']) expect(spec.messages.titanToPhone).toContain(JSON.parse(spec.frames[k]).t)
  })
  it('thread frame key order', () => {
    const keys = (k: string) => Object.keys(JSON.parse(spec.frames[k]))
    expect(keys('tattach')).toEqual(['t', 's'])
    expect(keys('tget')).toEqual(['t', 's', 'id'])
    expect(keys('tsnap')).toEqual(['t', 's', 'q', 'avail', 'why', 'entries', 'm'])
    expect(keys('tadd')).toEqual(['t', 's', 'q', 'e'])
    expect(keys('tmeta')).toEqual(['t', 's', 'm'])
    expect(keys('tdet')).toEqual(['t', 's', 'id', 'input', 'inMore', 'x', 'more'])
    expect(Object.keys(JSON.parse(spec.frames.tsnap).m)).toEqual(['ctxTok', 'ctxPct', 'work', 'since', 'tok', 'last', 'wait'])
  })
  it('the snapshot golden covers every entry kind and fits the budget', () => {
    const f = JSON.parse(spec.frames.tsnap)
    expect(f.entries.map((e: { k: string }) => e.k)).toEqual(['u', 'a', 'th', 't', 't'])
    expect(JSON.stringify(f.entries).length).toBeLessThanOrEqual(spec.threads.snapshotBytes)
  })
  it('welcomeCaps is the plain welcome plus caps', () => {
    expect(JSON.parse(spec.frames.welcomeCaps)).toEqual({ ...JSON.parse(spec.frames.welcome), caps: ['thread'] })
  })
})
