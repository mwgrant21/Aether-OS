import { describe, it, expect } from 'vitest';
import { renderNarration, FLEET_MAX_CHARS } from './voiceRender';
import { VOICE_PACKS } from './voicePacks';

describe('renderNarration', () => {
  it('renders the pack sample for the given severity', () => {
    expect(renderNarration(VOICE_PACKS.CINDER, 1)).toBe("It compiles. I'm thrilled.");
  });

  it('falls back to the nearest lower severity when a pack has no sample for that severity (FORGE sev 1)', () => {
    // FORGE has no sev-1 sample by design (silent heartbeat); renderNarration
    // still needs a deterministic non-throwing fallback for callers that
    // don't special-case severity 1 themselves.
    expect(renderNarration(VOICE_PACKS.FORGE, 1)).toBe('');
  });

  it('prepends the frozen phrase for a matching EventKind', () => {
    const result = renderNarration(VOICE_PACKS.CINDER, 4, 'critic_tell');
    expect(result.startsWith("Oh. That's actually interesting.")).toBe(true);
  });

  it('does not duplicate the frozen phrase when the sample already starts with it', () => {
    // CINDER own sev-4 sample already opens with the frozen phrase verbatim.
    const result = renderNarration(VOICE_PACKS.CINDER, 4, 'critic_tell');
    expect(result.match(/Oh\. That's actually interesting\./g)?.length).toBe(1);
  });

  it('truncates at the last full sentence boundary when over the cap, never mid-sentence', () => {
    const longPack = {
      ...VOICE_PACKS.CINDER,
      samples: { 1: 'Short one. Second sentence that pushes this well past a tiny cap. Third sentence.' },
      register: { ...VOICE_PACKS.CINDER.register, max_chars: { 1: 20 } },
    };
    const result = renderNarration(longPack, 1);
    expect(result).toBe('Short one.');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('uses fleet defaults when a pack has no max_chars override', () => {
    expect(FLEET_MAX_CHARS[1]).toBe(140);
    expect(FLEET_MAX_CHARS[2]).toBe(160);
    expect(FLEET_MAX_CHARS[3]).toBe(140);
    expect(FLEET_MAX_CHARS[4]).toBe(110);
  });
});
