import { describe, expect, it } from 'vitest';
import { buildChatActionResultText } from './chatActionResult';
import type { Approval } from './types';

function approval(overrides: Partial<Approval> = {}): Approval {
  return { id: 1, agent: 'AETHER', i: 'AE', hue: '#7fd8ef', action: 'Spawn Nightwatch', detail: '', risk: 'MED', ...overrides };
}

describe('buildChatActionResultText', () => {
  it('formats an approved spawn', () => {
    expect(buildChatActionResultText(approval({ verb: 'spawn', targetAgentName: 'Nightwatch' }), true)).toBe('✓ Approved — Nightwatch spawned.');
  });
  it('formats an approved kill', () => {
    expect(buildChatActionResultText(approval({ verb: 'kill', targetAgentName: 'Code Builder' }), true)).toBe('✓ Approved — Code Builder terminated.');
  });
  it('formats an approved throttle', () => {
    expect(buildChatActionResultText(approval({ verb: 'throttle', targetAgentName: 'Code Builder' }), true)).toBe("✓ Approved — Code Builder's draw throttled.");
  });
  it('formats a denial regardless of verb', () => {
    expect(buildChatActionResultText(approval({ verb: 'kill', targetAgentName: 'Code Builder', action: 'Kill Code Builder' }), false)).toBe('✗ Denied: Kill Code Builder.');
  });
  it('falls back to the generic action string for a verb-less approval (defensive; should not occur in practice)', () => {
    expect(buildChatActionResultText(approval({ verb: undefined }), true)).toBe('✓ Approved: Spawn Nightwatch.');
  });
});
