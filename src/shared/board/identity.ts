// Presentation helpers for the Traffic feed: avatar initials, per-agent colour,
// recipient chip text. Pure. Agent colours are signal, not theme, so this file
// deliberately imports neither React nor tokens.ts (same carve-out as the reactor).

import type { BoardParty } from './types'

export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') return '?'
  const words = trimmed.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '')
  if (words.length === 0) return '?'
  const chars = (w: string) => Array.from(w) // code points, so an astral letter is not split
  const out = words.length >= 2 ? chars(words[0])[0] + chars(words[1])[0] : chars(words[0]).slice(0, 2).join('')
  return out.toUpperCase()
}

function fnv1a32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function colorOf(key: string): string {
  return `hsl(${fnv1a32(key) % 360} 55% 58%)`
}

export function colorKeyOf(party: BoardParty): string {
  return party.agentId ?? party.name
}

export function recipientChip(party: BoardParty): string {
  if (party.kind === 'all') return '@all'
  if (party.kind === 'unknown') return '@unknown'
  return `@${party.name}`
}
