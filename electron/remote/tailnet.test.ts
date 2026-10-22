// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertBindableHost, findTailnetAddress, isTailnetIPv4 } from './tailnet'

const v4 = (address: string, family: string | number = 'IPv4', internal = false) => ({
  address,
  family,
  internal
})

describe('isTailnetIPv4', () => {
  it('accepts the CGNAT boundaries inclusively', () => {
    expect(isTailnetIPv4('100.63.255.255')).toBe(false)
    expect(isTailnetIPv4('100.64.0.0')).toBe(true)
    expect(isTailnetIPv4('100.127.255.255')).toBe(true)
    expect(isTailnetIPv4('100.128.0.0')).toBe(false)
  })

  it('rejects malformed, padded and leading-zero forms', () => {
    for (const bad of ['0100.64.0.1', '100.064.0.1', '100.64.0.01', ' 100.64.0.1', '100.64.0.1 ', '100.64.0.1/10', '100.64.0', '100.64.0.256', '1685389313', '', '::1']) {
      expect(isTailnetIPv4(bad)).toBe(false)
    }
  })
})

describe('findTailnetAddress', () => {
  it('returns null for the observed titan state (link-local only)', () => {
    expect(
      findTailnetAddress({
        Tailscale: [v4('169.254.83.107'), { address: 'fe80::1', family: 'IPv6', internal: false }],
        Ethernet: [v4('192.168.1.3')]
      })
    ).toBeNull()
  })

  it('returns the address of a healthy Tailscale interface', () => {
    expect(findTailnetAddress({ Tailscale: [v4('100.101.102.103')] })).toBe('100.101.102.103')
  })

  it('ignores a CGNAT address on a non-Tailscale interface', () => {
    expect(findTailnetAddress({ Ethernet: [v4('100.64.5.5')] })).toBeNull()
  })

  it('accepts numeric family 4, ignores internal entries, picks the smallest of several', () => {
    expect(findTailnetAddress({ tailscale0: [v4('100.100.0.9', 4)] })).toBe('100.100.0.9')
    expect(findTailnetAddress({ Tailscale: [v4('100.100.0.1', 'IPv4', true)] })).toBeNull()
    expect(findTailnetAddress({ Tailscale: [v4('100.100.0.9')], 'Tailscale 2': [v4('100.100.0.10')] })).toBe('100.100.0.10')
  })
})

describe('assertBindableHost', () => {
  it('allows tailnet and loopback IPv4', () => {
    expect(() => assertBindableHost('100.101.102.103')).not.toThrow()
    expect(() => assertBindableHost('127.0.0.1')).not.toThrow()
    expect(() => assertBindableHost('127.5.6.7')).not.toThrow()
  })

  it('throws for wildcard, hostname, LAN, link-local and odd forms', () => {
    for (const bad of ['0.0.0.0', '::', '::1', 'localhost', '', '192.168.1.3', '10.0.0.1', '172.16.0.1', '8.8.8.8', '169.254.83.107', '0100.64.0.1', '100.64.0.1/10', '2130706433', '0127.0.0.1', '127.0.0.1/8', 'example.com']) {
      expect(() => assertBindableHost(bad), bad).toThrow()
    }
  })
})
