import { describe, it, expect } from 'vitest';
import { toneForNotificationReason } from './alertSounds';

describe('toneForNotificationReason', () => {
  it('maps agent_needs_input to a distinct frequency', () => {
    expect(toneForNotificationReason('agent_needs_input')).toEqual({ frequencyHz: 660, durationSec: 0.18 });
  });
  it('maps agent_completed to a distinct frequency', () => {
    expect(toneForNotificationReason('agent_completed')).toEqual({ frequencyHz: 440, durationSec: 0.12 });
  });
  it('maps permission_prompt to a distinct frequency', () => {
    expect(toneForNotificationReason('permission_prompt')).toEqual({ frequencyHz: 880, durationSec: 0.25 });
  });
  it('falls back to a safe default tone for an unrecognized reason', () => {
    expect(toneForNotificationReason('something_new_from_a_future_claude_code_version')).toEqual({ frequencyHz: 550, durationSec: 0.15 });
  });
});
