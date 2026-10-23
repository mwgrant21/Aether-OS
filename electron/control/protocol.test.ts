// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MESSAGE_TYPES, PROTOCOL_VERSION, encodeBye, encodeWelcome, parsePhoneMessage } from './protocol';
import { CONTROL_BYE_REASONS, CONTROL_MESSAGE_TYPES } from '../../src/shared/remote/types';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../protocol/mobile-protocol.json'), 'utf8'));
const w = JSON.parse(spec.frames.welcome);

describe('control protocol matches protocol/mobile-protocol.json', () => {
  it('message types and version', () => {
    expect([...MESSAGE_TYPES.phoneToTitan]).toEqual(spec.messages.phoneToTitan);
    expect([...MESSAGE_TYPES.titanToPhone]).toEqual(spec.messages.titanToPhone);
    expect(PROTOCOL_VERSION).toBe(spec.v);
    expect(MESSAGE_TYPES).toEqual(CONTROL_MESSAGE_TYPES);
  });

  it('bye reasons', () => {
    expect([...CONTROL_BYE_REASONS]).toEqual(spec.messages.byeReasons);
  });

  it('golden hello parses to the same fields', () => {
    expect(parsePhoneMessage(spec.frames.hello)).toEqual(JSON.parse(spec.frames.hello));
  });

  it('golden welcome is reproduced byte for byte by encodeWelcome', () => {
    expect(encodeWelcome({ proof: w.proof, serverTimeMs: w.serverTimeMs, expiresAtMs: w.expiresAtMs })).toBe(spec.frames.welcome);
  });

  it('golden bye is reproduced byte for byte by encodeBye', () => {
    expect(encodeBye('revoked')).toBe(spec.frames.bye);
  });
});

describe('parsePhoneMessage', () => {
  const ok = { t: 'hello', v: 1, app: '0.2.0-v1', epoch: '0123456789abcdef', nonce: '00112233445566778899aabbccddeeff' };
  const parse = (o: unknown): ReturnType<typeof parsePhoneMessage> => parsePhoneMessage(JSON.stringify(o));

  it('ignores extra keys', () => {
    expect(parse({ ...ok, extra: 1 })).toEqual(ok);
  });

  it('rejects non-JSON, non-objects and unknown or missing types', () => {
    expect(parsePhoneMessage('not json')).toBeNull();
    expect(parsePhoneMessage('[]')).toBeNull();
    expect(parsePhoneMessage('null')).toBeNull();
    expect(parse({ ...ok, t: 'kill' })).toBeNull();
    expect(parse({ ...ok, t: 5 })).toBeNull();
    expect(parse({ v: 1 })).toBeNull();
  });

  it('rejects wrong version, app, epoch and nonce', () => {
    expect(parse({ ...ok, v: 2 })).toBeNull();
    expect(parse({ ...ok, v: '1' })).toBeNull();
    expect(parse({ ...ok, app: 'x'.repeat(33) })).toBeNull();
    expect(parse({ ...ok, app: 7 })).toBeNull();
    expect(parse({ ...ok, epoch: '0123456789ABCDEF' })).toBeNull();
    expect(parse({ ...ok, epoch: '0123456789abcde' })).toBeNull();
    expect(parse({ ...ok, nonce: '00112233445566778899aabbccddeef' })).toBeNull();
    expect(parse({ ...ok, nonce: 'g0112233445566778899aabbccddeeff' })).toBeNull();
  });

  it('accepts an app string of exactly 32 characters', () => {
    expect(parse({ ...ok, app: 'x'.repeat(32) })).not.toBeNull();
  });
});
