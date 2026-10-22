import os from 'node:os'

type IfaceEntry = {
  address: string
  family: string | number
  internal?: boolean
}
type IfaceTable = Record<string, IfaceEntry[] | undefined>

/** Strict dotted quad: four decimal octets 0-255, no leading zeros, no whitespace. */
function parseQuad(ip: string): number[] | null {
  if (typeof ip !== 'string') return null
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(ip)
  if (!m) return null
  const octets = m.slice(1).map(Number)
  return octets.every((o) => o <= 255) ? octets : null
}

/** True for an IPv4 inside 100.64.0.0/10 (the Tailscale/CGNAT range). */
export function isTailnetIPv4(ip: string): boolean {
  const o = parseQuad(ip)
  return o !== null && o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/**
 * The tailnet address of a Tailscale interface, or null. Only interfaces named
 * like Tailscale count: ISPs hand out 100.64/10 on the WAN too.
 */
export function findTailnetAddress(ifaces: IfaceTable = os.networkInterfaces() as IfaceTable): string | null {
  const found: string[] = []
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!/tailscale/i.test(name) || !entries) continue
    for (const e of entries) {
      if ((e.family === 'IPv4' || e.family === 4) && !e.internal && isTailnetIPv4(e.address)) {
        found.push(e.address)
      }
    }
  }
  if (found.length === 0) return null
  return found.sort()[0]
}

/** Throws unless host is a tailnet IPv4 or a 127.0.0.0/8 loopback IPv4 (tests). */
export function assertBindableHost(host: string): void {
  if (isTailnetIPv4(host)) return
  const o = parseQuad(host)
  if (o !== null && o[0] === 127) return
  throw new Error('remote: refusing to bind a non-tailnet address')
}
