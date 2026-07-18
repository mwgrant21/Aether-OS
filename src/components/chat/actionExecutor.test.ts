import { describe, expect, it } from 'vitest';
import { buildApprovalPayload, buildSafeCommandRaw, RISK_POLICY, shouldAutoApprove } from './actionExecutor';
import type { ChatChannel } from './chatChannels';

const aetherChannel: ChatChannel = { id: 'AETHER', kind: 'aether', name: 'AETHER', initials: 'AE', hue: '#7fd8ef', archived: false };
const agentChannel: ChatChannel = { id: 'Code Builder', kind: 'agent', name: 'Code Builder', initials: 'CB', hue: '#7ef0ff', archived: false };

describe('RISK_POLICY', () => {
  it('assigns kill=HIGH, spawn=MED, throttle=LOW', () => {
    expect(RISK_POLICY.kill).toBe('HIGH');
    expect(RISK_POLICY.spawn).toBe('MED');
    expect(RISK_POLICY.throttle).toBe('LOW');
  });
});

describe('buildSafeCommandRaw', () => {
  it('builds a valid theme raw command', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 'violet' } })).toBe('theme violet');
  });
  it('builds a valid renderer raw command', () => {
    expect(buildSafeCommandRaw({ verb: 'renderer', args: { mode: 'volumetric' } })).toBe('renderer volumetric');
  });
  it('returns null for an invalid theme name', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 'not-a-theme' } })).toBeNull();
  });
  it('returns null for an invalid renderer mode', () => {
    expect(buildSafeCommandRaw({ verb: 'renderer', args: { mode: 'chaos' } })).toBeNull();
  });
  it('returns null for a non-safe verb', () => {
    expect(buildSafeCommandRaw({ verb: 'spawn', args: { name: 'X' } })).toBeNull();
  });
  it('returns null when the relevant arg is missing or non-string', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: {} })).toBeNull();
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 42 } })).toBeNull();
  });
});

describe('buildApprovalPayload', () => {
  it('builds a spawn approval from the AETHER channel', () => {
    const payload = buildApprovalPayload(aetherChannel, { verb: 'spawn', args: { name: 'Nightwatch' } });
    expect(payload).toMatchObject({ agent: 'AETHER', risk: 'MED', verb: 'spawn', targetAgentName: 'Nightwatch', channelId: 'AETHER' });
  });
  it('builds a kill approval from an agent channel', () => {
    const payload = buildApprovalPayload(agentChannel, { verb: 'kill', args: { name: 'Test Runner' } });
    expect(payload).toMatchObject({ agent: 'Code Builder', risk: 'HIGH', verb: 'kill', targetAgentName: 'Test Runner', channelId: 'Code Builder' });
  });
  it('builds a throttle approval', () => {
    const payload = buildApprovalPayload(agentChannel, { verb: 'throttle', args: { name: 'Code Builder' } });
    expect(payload).toMatchObject({ risk: 'LOW', verb: 'throttle', targetAgentName: 'Code Builder' });
  });
  it('returns null for a non-risky verb', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'theme', args: { name: 'cyan' } })).toBeNull();
  });
  it('returns null when args.name is missing or non-string, for spawn', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'spawn', args: {} })).toBeNull();
    expect(buildApprovalPayload(aetherChannel, { verb: 'spawn', args: { name: 42 } })).toBeNull();
  });
  it('returns null when args.name is missing or non-string, for kill', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'kill', args: {} })).toBeNull();
    expect(buildApprovalPayload(aetherChannel, { verb: 'kill', args: { name: 42 } })).toBeNull();
  });
  it('returns null when args.name is missing or non-string, for throttle', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'throttle', args: {} })).toBeNull();
    expect(buildApprovalPayload(aetherChannel, { verb: 'throttle', args: { name: 42 } })).toBeNull();
  });
  it('never sets verb without targetAgentName also set, for all three risky verbs (RESOLVE_APPROVAL invariant)', () => {
    for (const verb of ['spawn', 'kill', 'throttle'] as const) {
      const missing = buildApprovalPayload(aetherChannel, { verb, args: {} });
      const nonString = buildApprovalPayload(aetherChannel, { verb, args: { name: 42 } });
      expect(missing).toBeNull();
      expect(nonString).toBeNull();
    }
  });
});

describe('shouldAutoApprove', () => {
  it('is true only for AUTO opMode and non-HIGH risk', () => {
    expect(shouldAutoApprove('MED', 'AUTO')).toBe(true);
    expect(shouldAutoApprove('LOW', 'AUTO')).toBe(true);
    expect(shouldAutoApprove('HIGH', 'AUTO')).toBe(false);
    expect(shouldAutoApprove('MED', 'EDITS')).toBe(false);
    expect(shouldAutoApprove('MED', 'PLAN')).toBe(false);
  });
});
