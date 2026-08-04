import { describe, it, expect } from 'vitest';
import { resolveVoiceRole } from './agentVoiceRoles';

describe('resolveVoiceRole', () => {
  it('maps known review/critic subagent types to CINDER', () => {
    expect(resolveVoiceRole('code-reviewer')).toBe('CINDER');
    expect(resolveVoiceRole('silent-failure-hunter')).toBe('CINDER');
  });

  it('maps known explorer subagent types to PILGRIM', () => {
    expect(resolveVoiceRole('Explore')).toBe('PILGRIM');
  });

  it('maps known verifier subagent types to ASSAY', () => {
    expect(resolveVoiceRole('pr-test-analyzer')).toBe('ASSAY');
  });

  it('maps known orchestrator subagent types to STEWARD', () => {
    expect(resolveVoiceRole('project-orchestrator')).toBe('STEWARD');
  });

  it('falls back to FORGE for unmapped subagent types', () => {
    expect(resolveVoiceRole('general-purpose')).toBe('FORGE');
    expect(resolveVoiceRole('some-brand-new-agent-type')).toBe('FORGE');
  });

  it('is case-sensitive and does not fuzzy-match', () => {
    expect(resolveVoiceRole('CODE-REVIEWER')).toBe('FORGE');
  });
});
