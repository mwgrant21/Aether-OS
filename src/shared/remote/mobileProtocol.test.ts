import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as T from './types'

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
