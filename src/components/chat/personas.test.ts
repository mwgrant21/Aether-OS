import { describe, expect, it } from 'vitest';
import { FALLBACK_PERSONA, PERSONAS, resolvePersona } from './personas';
import { initialState } from '../../state/initialState';

// Every name that actually exists in this codebase's seed roster and
// auto-spawn pool must have a dedicated persona -- not the fallback. The
// auto-spawn pool itself isn't exported from commands.ts (it's a local
// const inside `nextAutoName`), so these five are duplicated here as
// literals; keep them in sync with src/components/terminal/commands.ts's
// `nextAutoName` pool if that list ever changes.
const AUTO_SPAWN_POOL = ['Image Gen', 'Sentry', 'Doc Writer', 'Optimizer', 'Auditor'];

describe('resolvePersona', () => {
  it('returns a dedicated persona for every active seed agent name', () => {
    for (const agent of initialState.agents) {
      expect(resolvePersona(agent.name)).not.toBe(FALLBACK_PERSONA);
      expect(PERSONAS[agent.name]).toBeDefined();
    }
  });

  it('returns a dedicated persona for every idle/archived seed agent name', () => {
    for (const idle of initialState.idleList) {
      expect(resolvePersona(idle.name)).not.toBe(FALLBACK_PERSONA);
    }
  });

  it('returns a dedicated persona for every auto-spawn pool name', () => {
    for (const name of AUTO_SPAWN_POOL) {
      expect(resolvePersona(name)).not.toBe(FALLBACK_PERSONA);
    }
  });

  it('falls back to FALLBACK_PERSONA for a custom-spawned name', () => {
    expect(resolvePersona('My Custom Agent Name')).toBe(FALLBACK_PERSONA);
  });

  it('falls back to FALLBACK_PERSONA for the Auxiliary-N overflow name', () => {
    expect(resolvePersona('Auxiliary 6')).toBe(FALLBACK_PERSONA);
  });

  it('gives Code Builder a terse/technical voice, matching the designer spec', () => {
    expect(PERSONAS['Code Builder'].voice.toLowerCase()).toContain('terse');
  });

  it('gives Database Agent a numbers-first voice (not the invented "Data Agent" name)', () => {
    expect(PERSONAS['Database Agent']).toBeDefined();
    expect(PERSONAS['Database Agent'].voice.toLowerCase()).toContain('numbers');
  });
});
