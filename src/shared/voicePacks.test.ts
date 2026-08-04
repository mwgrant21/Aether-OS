import { describe, it, expect } from 'vitest';
import { VOICE_PACKS } from './voicePacks';

const ROLES = ['STEWARD', 'CINDER', 'PILGRIM', 'ASSAY', 'FORGE'] as const;

describe('VOICE_PACKS', () => {
  it('has exactly the 5 spec roles, no more, no fewer', () => {
    expect(Object.keys(VOICE_PACKS).sort()).toEqual([...ROLES].sort());
  });

  it('every pack has a sample for severities 1-4', () => {
    for (const role of ROLES) {
      const pack = VOICE_PACKS[role];
      for (const sev of [1, 2, 3, 4] as const) {
        // FORGE intentionally has no sev 1 sample (spec §5.9), verified in separate test
        if (role === 'FORGE' && sev === 1) continue;
        expect(pack.samples[sev], `${role} missing sample for sev ${sev}`).toBeTruthy();
      }
    }
  });

  it('FORGE has no sample for severity 1 (silent heartbeat, spec §5.9)', () => {
    expect(VOICE_PACKS.FORGE.samples[1]).toBeUndefined();
  });

  it('carries the 4 frozen phrases on their spec-assigned packs', () => {
    expect(VOICE_PACKS.CINDER.frozen.critic_tell).toBe("Oh. That's actually interesting.");
    expect(VOICE_PACKS.ASSAY.frozen.no_signal).toBe('Treat everything unverified.');
    expect(VOICE_PACKS.STEWARD.frozen.all_clear).toBe('Nothing requires you.');
    expect(VOICE_PACKS.PILGRIM.frozen.empty_result).toBe("The path exists. It's empty.");
  });

  it('CINDER is the only engaged-curve pack (spec §5.2)', () => {
    const engaged = ROLES.filter((r) => VOICE_PACKS[r].register.escalation_curve === 'engaged');
    expect(engaged).toEqual(['CINDER']);
  });
});
