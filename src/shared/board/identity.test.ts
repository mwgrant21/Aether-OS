import { describe, it, expect } from 'vitest'
import { initialsOf, colorOf, colorKeyOf, recipientChip } from './identity'

const party = (kind: string, name: string, agentId: string | null = null) => ({ kind, name, agentId })

describe('initialsOf', () => {
  it.each([
    ['general-purpose', 'GP'],
    ['builder', 'BU'],
    ['Explore', 'EX'],
    ['main', 'MA'],
    ['matt-51 [e2f673]', 'M5'],
    ['', '?'],
    ['unknown', '?'],
  ])('%j -> %j', (input, expected) => {
    expect(initialsOf(input)).toBe(expected)
  })
})

describe('colorOf', () => {
  it('is stable and well-formed', () => {
    expect(colorOf('a1b2c3d4e5f6')).toBe(colorOf('a1b2c3d4e5f6'))
    expect(colorOf('a1b2c3d4e5f6')).toMatch(/^hsl\(\d{1,3} 55% 58%\)$/)
  })
  it('spreads 12 agent ids over at least 8 distinct hues', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}f3c9d2e1b${(i * 7919).toString(16)}`)
    expect(new Set(ids.map(colorOf)).size).toBeGreaterThanOrEqual(8)
  })
})

describe('colorKeyOf', () => {
  it('prefers agentId over name', () => {
    expect(colorKeyOf(party('agent', 'builder', 'abc123def456'))).toBe('abc123def456')
    expect(colorKeyOf(party('main', 'main'))).toBe('main')
  })
})

describe('recipientChip', () => {
  it('formats each party kind', () => {
    expect(recipientChip(party('all', 'all'))).toBe('@all')
    expect(recipientChip(party('unknown', 'unknown'))).toBe('@unknown')
    expect(recipientChip(party('agent', 'builder', 'abc'))).toBe('@builder')
    expect(recipientChip(party('peer', 'peer session'))).toBe('@peer session')
    expect(recipientChip(party('main', 'main'))).toBe('@main')
  })
})
