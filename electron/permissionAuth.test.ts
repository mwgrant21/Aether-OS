import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createPermissionSecret,
  encodePortFile,
  isValidNonce,
  signPermission,
  verifySignature,
} from './permissionAuth';

describe('permissionAuth', () => {
  it('creates a fresh 32-byte hex secret per call', () => {
    const a = createPermissionSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(createPermissionSecret()).not.toBe(a);
  });

  it('signs role, nonce and path with HMAC-SHA256 so client and server proofs differ', () => {
    const secret = 'ab'.repeat(32);
    const nonce = 'cd'.repeat(16);
    const expected = createHmac('sha256', secret).update(`client\n${nonce}\n/permission-request`).digest('hex');
    expect(signPermission(secret, 'client', nonce, '/permission-request')).toBe(expected);
    expect(signPermission(secret, 'server', nonce, '/permission-request')).not.toBe(expected);
    expect(signPermission(secret, 'client', nonce, '/notification')).not.toBe(expected);
  });

  it('verifies only an exact hex signature, never a missing or malformed one', () => {
    const sig = signPermission('ab'.repeat(32), 'client', 'cd'.repeat(16), '/x');
    expect(verifySignature(sig, sig)).toBe(true);
    expect(verifySignature(sig, undefined)).toBe(false);
    expect(verifySignature(sig, sig.slice(0, -2))).toBe(false);
    expect(verifySignature(sig, sig.replace(/.$/, sig.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(verifySignature(sig, ['a', 'b'])).toBe(false);
  });

  it('accepts only lowercase hex nonces of 32-128 chars', () => {
    expect(isValidNonce('ab'.repeat(16))).toBe(true);
    expect(isValidNonce('ab'.repeat(8))).toBe(false);
    expect(isValidNonce('XY'.repeat(16))).toBe(false);
    expect(isValidNonce(undefined)).toBe(false);
  });

  it('encodes the port file as JSON carrying both port and secret', () => {
    const secret = 'ef'.repeat(32);
    expect(JSON.parse(encodePortFile(51823, secret))).toEqual({ port: 51823, secret });
  });
});
