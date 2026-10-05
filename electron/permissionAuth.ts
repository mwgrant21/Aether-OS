// Mutual authentication for the loopback permission server and its hook
// client (scripts/aether-permission-hook.mjs, which mirrors signPermission
// with node:crypto because it must stay import-free).
//
// Security audit 2026-10-04: the server accepted any local caller, so any
// process or browser page could inject approval cards; and the hook trusted
// any listener on the port named in a file that outlived the app, so a port
// squatter could answer PermissionRequest with allow + a substituted input.
//
// Both sides share a per-launch secret held only in the user-only port file.
// The client sends a fresh nonce and HMAC(secret, "client\n<nonce>\n<path>");
// the server answers with HMAC(secret, "server\n<nonce>\n<path>"). The secret
// itself never crosses the socket, so a squatter learns nothing it can use.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';

export const NONCE_HEADER = 'x-aether-nonce';
export const AUTH_HEADER = 'x-aether-auth';
export const PROOF_HEADER = 'x-aether-proof';

export function createPermissionSecret(): string {
  return randomBytes(32).toString('hex');
}

export function isValidSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && /^[0-9a-f]{64}$/.test(secret);
}

export function isValidNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && /^[0-9a-f]{32,128}$/.test(nonce);
}

export function signPermission(secret: string, role: 'client' | 'server', nonce: string, path: string): string {
  return createHmac('sha256', secret).update(`${role}\n${nonce}\n${path}`).digest('hex');
}

/** Constant-time comparison of two hex signatures; anything malformed is false. */
export function verifySignature(expectedHex: string, given: unknown): boolean {
  if (typeof given !== 'string' || !/^[0-9a-f]+$/.test(given) || given.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(given, 'hex'));
}

/** Contents of ~/.aether-os/permission-server-port. A bare port number (the
 *  pre-2026-10-04 format) carries no secret, so the hook falls through. */
export function encodePortFile(port: number, secret: string): string {
  return JSON.stringify({ port, secret });
}

/** Publishes the port file as a NEW user-only file. writeFile's `mode` only
 *  applies on creation, so an existing (legacy, umask-moded) file is removed
 *  first and the replacement created exclusively: 'wx' also refuses to follow
 *  a link planted at the path. On Windows the mode is ignored; the user-only
 *  ACL comes from ensurePrivateDir on ~/.aether-os, which main.ts awaits first. */
export async function writePortFile(path: string, port: number, secret: string): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, encodePortFile(port, secret), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}
