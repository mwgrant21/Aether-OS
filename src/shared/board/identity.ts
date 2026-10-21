// Presentation helpers for the Traffic feed: avatar initials, per-agent colour,
// recipient chip text. Pure. Agent colours are signal, not theme, so this file
// deliberately imports neither React nor tokens.ts (same carve-out as the reactor).

// Local structural type until T1's BoardParty is merged; T7 switches to the import.
interface PartyLike {
  kind: string
  name: string
  agentId: string | null
}

export function initialsOf(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') return '?'
  const words = trimmed.split(/[^A-Za-z0-9]+/).filter((w) => w !== '')
  if (words.length === 0) return '?'
  const out = words.length >= 2 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
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

export function colorKeyOf(party: PartyLike): string {
  return party.agentId ?? party.name
}

export function recipientChip(party: PartyLike): string {
  if (party.kind === 'all') return '@all'
  if (party.kind === 'unknown') return '@unknown'
  return `@${party.name}`
}
