import { describe, it, expect } from 'vitest';
import { buildAetherLaunchCommand } from './launchCommand';
import type { LaunchEffort, ModelAlias } from '../../src/shared/aetherChoice/types';
import { buildClaudeLaunchCommand, buildPtyEnv, UNMONITORED_TERMINAL_ENV } from '../ptyManager';

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const bad = (v: string) => v as unknown as ModelAlias & LaunchEffort;

describe('buildAetherLaunchCommand', () => {
  it('builds the exact fresh, session-id and resume strings', () => {
    expect(buildAetherLaunchCommand({ model: 'sonnet', effort: 'medium' })).toBe(
      'claude --model sonnet --effort medium\r',
    );
    expect(buildAetherLaunchCommand({ model: 'opus', effort: 'high', sessionId: UUID })).toBe(
      `claude --session-id ${UUID} --model opus --effort high\r`,
    );
    expect(buildAetherLaunchCommand({ model: 'haiku', effort: 'low', resume: true })).toBe(
      'claude --continue --model haiku --effort low\r',
    );
  });

  it('throws on fable and on free-text models', () => {
    expect(() => buildAetherLaunchCommand({ model: bad('fable'), effort: 'low' })).toThrow(/fable/);
    expect(() => buildAetherLaunchCommand({ model: bad('sonnet; rm'), effort: 'low' })).toThrow(
      /sonnet; rm/,
    );
  });

  it('throws on an effort outside the CLI list', () => {
    expect(() => buildAetherLaunchCommand({ model: 'sonnet', effort: bad('turbo') })).toThrow(/turbo/);
  });

  it('throws on a bad uuid and on resume combined with sessionId', () => {
    expect(() => buildAetherLaunchCommand({ model: 'sonnet', effort: 'low', sessionId: 'nope' })).toThrow(
      /nope/,
    );
    expect(() =>
      buildAetherLaunchCommand({ model: 'sonnet', effort: 'low', resume: true, sessionId: UUID }),
    ).toThrow(/resume/);
  });

  it('carries --model and --effort exactly once on every form', () => {
    const forms = [
      buildAetherLaunchCommand({ model: 'sonnet', effort: 'max' }),
      buildAetherLaunchCommand({ model: 'sonnet', effort: 'max', sessionId: UUID }),
      buildAetherLaunchCommand({ model: 'sonnet', effort: 'max', resume: true }),
    ];
    for (const f of forms) {
      expect(f.split('--model').length - 1).toBe(1);
      expect(f.split('--effort').length - 1).toBe(1);
    }
  });
});

describe('default launch and env are unchanged', () => {
  it('ptyManager launch has no --continue, --model or --effort', () => {
    for (const s of [buildClaudeLaunchCommand(), buildClaudeLaunchCommand(UUID)]) {
      expect(s).not.toContain('--continue');
      expect(s).not.toContain('--model');
      expect(s).not.toContain('--effort');
    }
  });

  it('pty env from an empty source has no model or effort override vars', () => {
    const envs = [buildPtyEnv({}), { ...buildPtyEnv({}), ...UNMONITORED_TERMINAL_ENV }];
    for (const e of envs) {
      expect('CLAUDE_CODE_EFFORT_LEVEL' in e).toBe(false);
      expect('ANTHROPIC_MODEL' in e).toBe(false);
    }
  });
});
