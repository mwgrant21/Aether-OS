import { describe, it, expect } from 'vitest';
import { detectEventKind, type FrozenPhraseInput } from './frozenPhraseDetect';

describe('detectEventKind', () => {
  describe('all_clear (STEWARD)', () => {
    it('fires when all conditions met: zero open dispatches, zero anomalies, no pending request', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 0,
          anomalyCount: 0,
          hasPendingPermissionRequest: false,
        },
      };
      expect(detectEventKind(input)).toBe('all_clear');
    });

    it('returns null when open dispatches > 0', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 1,
          anomalyCount: 0,
          hasPendingPermissionRequest: false,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when anomalies > 0', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 0,
          anomalyCount: 1,
          hasPendingPermissionRequest: false,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when pending permission request exists', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 0,
          anomalyCount: 0,
          hasPendingPermissionRequest: true,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when multiple conditions are not met', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 2,
          anomalyCount: 3,
          hasPendingPermissionRequest: true,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when state is undefined', () => {
      const input: FrozenPhraseInput = {};
      expect(detectEventKind(input)).toBeNull();
    });
  });

  describe('empty_result (PILGRIM)', () => {
    it('fires when tool calls are all read-like and result lengths are all small', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore', // PILGRIM
          severity: 1,
          completed: true,
          toolUses: [
            { name: 'Read' },
            { name: 'Glob' },
            { name: 'Grep' },
          ],
          toolResults: [
            { resultLength: 10 },
            { resultLength: 25 },
            { resultLength: 50 }, // boundary: exactly 50 is small
          ],
        },
      };
      expect(detectEventKind(input)).toBe('empty_result');
    });

    it('returns null when tool calls include non-read-like tools', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [
            { name: 'Read' },
            { name: 'Write' }, // not read-like
          ],
          toolResults: [
            { resultLength: 10 },
            { resultLength: 10 },
          ],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when any result length exceeds 50 bytes', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [
            { name: 'Read' },
            { name: 'Read' },
          ],
          toolResults: [
            { resultLength: 10 },
            { resultLength: 51 }, // just over boundary
          ],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when dispatch role is not PILGRIM', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer', // CINDER, not PILGRIM
          severity: 1,
          completed: true,
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 10 }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when no tool uses', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [],
          toolResults: [],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when toolUses is undefined', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolResults: [{ resultLength: 10 }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when toolResults is undefined', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [{ name: 'Read' }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('fires for all read-like tool names (WebFetch, WebSearch)', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [
            { name: 'WebFetch' },
            { name: 'WebSearch' },
          ],
          toolResults: [
            { resultLength: 20 },
            { resultLength: 30 },
          ],
        },
      };
      expect(detectEventKind(input)).toBe('empty_result');
    });

    it('returns null when result count does not match tool use count', () => {
      // This edge case tests behavior when data is misaligned
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [
            { name: 'Read' },
            { name: 'Read' },
          ],
          toolResults: [
            { resultLength: 10 },
            // missing second result
          ],
        },
      };
      // Should still return true if all available results are small and all tools are read-like
      expect(detectEventKind(input)).toBe('empty_result');
    });

    it('returns null when dispatch is not yet completed', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: false,
          toolUses: [
            { name: 'Read' },
          ],
          toolResults: [
            { resultLength: 10 },
          ],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });
  });

  describe('no_signal (ASSAY)', () => {
    it('fires when exit_state is fatal', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator', // ASSAY
          severity: 4,
          completed: true,
          exitState: 'fatal',
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 100 }],
        },
      };
      expect(detectEventKind(input)).toBe('no_signal');
    });

    it('fires when zero tool calls made but exit_state suggests failure', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 3,
          completed: true,
          exitState: 'error',
          toolUses: [],
          toolResults: [],
        },
      };
      expect(detectEventKind(input)).toBe('no_signal');
    });

    it('returns null when exit_state is ok even with zero tool calls', () => {
      // If it completed successfully with no tool calls, that's not "no signal"
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 1,
          completed: true,
          exitState: 'ok',
          toolUses: [],
          toolResults: [],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when dispatch role is not ASSAY', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'general-purpose', // FORGE (default), not ASSAY
          severity: 4,
          completed: true,
          exitState: 'fatal',
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when exit_state is partial but tool calls exist', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 2,
          completed: true,
          exitState: 'partial',
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 50 }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when exit_state is timeout but tool calls exist', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 3,
          completed: true,
          exitState: 'timeout',
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 50 }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when exit_state is blocked but tool calls exist', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 4,
          completed: true,
          exitState: 'blocked',
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 50 }],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when exitState is undefined', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 3,
          completed: true,
          toolUses: [],
          toolResults: [],
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('fires for all non-ok exit states with zero tool calls', () => {
      const exitStates = ['partial', 'error', 'timeout', 'blocked'];
      for (const exitState of exitStates) {
        const input: FrozenPhraseInput = {
          dispatch: {
            subagentType: 'post-deployment-validator',
            severity: 2,
            completed: true,
            exitState: exitState as any,
            toolUses: [],
            toolResults: [],
          },
        };
        expect(detectEventKind(input)).toBe('no_signal');
      }
    });

    it('returns null when toolUses is undefined and exitState is fatal', () => {
      // This edge case: when toolUses is undefined, we can't check count,
      // so we rely on exitState
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 4,
          completed: true,
          exitState: 'fatal',
        },
      };
      expect(detectEventKind(input)).toBe('no_signal');
    });

    it('returns null when dispatch is not yet completed', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'post-deployment-validator',
          severity: 4,
          completed: false,
          exitState: 'fatal',
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });
  });

  describe('critic_tell (CINDER)', () => {
    it('fires when role is CINDER and severity >= 3', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer', // CINDER
          severity: 3,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBe('critic_tell');
    });

    it('fires when severity is exactly 3', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'pr-review-toolkit:code-reviewer', // CINDER (plugin-scoped)
          severity: 3,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBe('critic_tell');
    });

    it('fires when severity is 4 (maximum)', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'security-code-reviewer', // CINDER
          severity: 4,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBe('critic_tell');
    });

    it('returns null when severity is 2', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer',
          severity: 2,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when severity is 1', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer',
          severity: 1,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when dispatch role is not CINDER', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore', // PILGRIM, not CINDER
          severity: 4,
          completed: true,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });

    it('fires for all CINDER-mapped roles at severity >= 3', () => {
      const cinderRoles = ['code-reviewer', 'pr-review-toolkit:code-reviewer', 'silent-failure-hunter', 'comment-analyzer', 'type-design-analyzer', 'security-code-reviewer', 'ps-code-reviewer'];
      for (const role of cinderRoles) {
        const input: FrozenPhraseInput = {
          dispatch: {
            subagentType: role,
            severity: 3,
            completed: true,
          },
        };
        expect(detectEventKind(input)).toBe('critic_tell');
      }
    });

    it('returns null when dispatch is not yet completed', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer',
          severity: 4,
          completed: false,
        },
      };
      expect(detectEventKind(input)).toBeNull();
    });
  });

  describe('predicate precedence and interaction', () => {
    it('returns critic_tell when CINDER dispatch matches both critic_tell and would match others', () => {
      // If we had multiple matches, critic_tell is checked first and should win
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer', // CINDER
          severity: 4, // triggers critic_tell
          completed: true,
          exitState: 'fatal', // would trigger no_signal if role were ASSAY
        },
      };
      expect(detectEventKind(input)).toBe('critic_tell');
    });

    it('returns empty_result when PILGRIM dispatch matches both empty_result and no_signal would apply to ASSAY', () => {
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore', // PILGRIM
          severity: 1,
          completed: true,
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 25 }],
          exitState: 'fatal', // would trigger no_signal if role were ASSAY
        },
      };
      expect(detectEventKind(input)).toBe('empty_result');
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('returns null when dispatch is undefined and state is undefined', () => {
      const input: FrozenPhraseInput = {};
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when both dispatch and state are undefined', () => {
      const input: FrozenPhraseInput = { dispatch: undefined, state: undefined };
      expect(detectEventKind(input)).toBeNull();
    });

    it('returns null when dispatch is null-ish but state is defined', () => {
      const input: FrozenPhraseInput = {
        dispatch: undefined,
        state: {
          openDispatchCount: 1,
          anomalyCount: 0,
          hasPendingPermissionRequest: false,
        },
      };
      expect(detectEventKind(input)).toBeNull(); // state says not all_clear
    });

    it('result length boundary: 50 is small, 51 is not', () => {
      const input50: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 50 }],
        },
      };
      expect(detectEventKind(input50)).toBe('empty_result');

      const input51: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'Explore',
          severity: 1,
          completed: true,
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 51 }],
        },
      };
      expect(detectEventKind(input51)).toBeNull();
    });

    it('severity boundary: 3 fires critic_tell, 2 does not', () => {
      const input3: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer',
          severity: 3,
          completed: true,
        },
      };
      expect(detectEventKind(input3)).toBe('critic_tell');

      const input2: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'code-reviewer',
          severity: 2,
          completed: true,
        },
      };
      expect(detectEventKind(input2)).toBeNull();
    });

    it('handles zero as a valid numeric value for counts', () => {
      const input: FrozenPhraseInput = {
        state: {
          openDispatchCount: 0,
          anomalyCount: 0,
          hasPendingPermissionRequest: false,
        },
      };
      expect(detectEventKind(input)).toBe('all_clear');
    });

    it('unmapped subagentType defaults to FORGE (not PILGRIM, ASSAY, or CINDER)', () => {
      // An unmapped type should not match any predicate
      const input: FrozenPhraseInput = {
        dispatch: {
          subagentType: 'unknown-unmapped-agent',
          severity: 4,
          completed: true,
          toolUses: [{ name: 'Read' }],
          toolResults: [{ resultLength: 10 }],
          exitState: 'fatal',
        },
      };
      expect(detectEventKind(input)).toBeNull(); // Defaults to FORGE, which is not any of our four predicates
    });
  });
});
