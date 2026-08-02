import { describe, it, expect, vi } from 'vitest';
import { handleNotification, selectMostRecentOpenDispatch } from './notificationHandler';
import { createHeadlineThrottle, shouldCallForHeadline } from './headlineGenerator';
import type { RealAgentDispatch } from '../src/state/liveAgentsMath';

function mockDispatch(overrides: Partial<RealAgentDispatch> = {}): RealAgentDispatch {
  return {
    toolUseId: 't1',
    subagentType: 'general-purpose',
    description: 'run npm install',
    startedAt: '2026-07-29T10:00:00.000Z',
    prompt: '',
    model: null,
    ...overrides,
  };
}

describe('selectMostRecentOpenDispatch', () => {
  it('picks the most recently started dispatch', () => {
    const older = mockDispatch({ toolUseId: 'old', startedAt: '2026-07-29T10:00:00.000Z' });
    const newer = mockDispatch({ toolUseId: 'new', startedAt: '2026-07-29T10:05:00.000Z' });
    expect(selectMostRecentOpenDispatch([older, newer])?.toolUseId).toBe('new');
  });

  it('returns undefined for an empty list', () => {
    expect(selectMostRecentOpenDispatch([])).toBeUndefined();
  });
});

describe('handleNotification', () => {
  it('ignores notifications for a different session', () => {
    const sendHeadline = vi.fn();
    const onUnfocused = vi.fn();
    handleNotification(
      { sessionId: 'other-session', notificationType: 'permission_prompt' },
      'own-session',
      {
        isWindowFocused: () => false,
        getOpenDispatches: () => [mockDispatch()],
        headlineThrottle: createHeadlineThrottle(),
        sendHeadline,
        onUnfocusedNotification: onUnfocused,
      }
    );
    expect(sendHeadline).not.toHaveBeenCalled();
    expect(onUnfocused).not.toHaveBeenCalled();
  });

  // Regression test for Stage 7 final-review bug #2: the blocked-trigger
  // branch must not run at all while the window is focused -- isWindowFocused
  // gates the ENTIRE handler, no exceptions.
  it('does not fire the blocked headline or the unfocused-notification side effects while the window is focused', () => {
    const sendHeadline = vi.fn();
    const onUnfocused = vi.fn();
    handleNotification(
      { sessionId: 'own-session', notificationType: 'permission_prompt' },
      'own-session',
      {
        isWindowFocused: () => true,
        getOpenDispatches: () => [mockDispatch()],
        headlineThrottle: createHeadlineThrottle(),
        sendHeadline,
        onUnfocusedNotification: onUnfocused,
      }
    );
    expect(sendHeadline).not.toHaveBeenCalled();
    expect(onUnfocused).not.toHaveBeenCalled();
  });

  it('fires the blocked headline and unfocused side effects when not focused', () => {
    const sendHeadline = vi.fn();
    const onUnfocused = vi.fn();
    const dispatch = mockDispatch();
    handleNotification(
      { sessionId: 'own-session', notificationType: 'permission_prompt' },
      'own-session',
      {
        isWindowFocused: () => false,
        getOpenDispatches: () => [dispatch],
        headlineThrottle: createHeadlineThrottle(),
        sendHeadline,
        onUnfocusedNotification: onUnfocused,
      }
    );
    expect(sendHeadline).toHaveBeenCalledWith('t1', 'general-purpose needs a permission decision');
    expect(onUnfocused).toHaveBeenCalledWith('permission_prompt');
  });

  // Regression test for Stage 7 final-review bug #1: a blocked headline must
  // record into the shared throttle map so the periodic loop's
  // shouldCallForHeadline treats the toolUseId as "already handled recently"
  // and does not immediately overwrite it at its next 15s boundary.
  it('records the blocked headline call into the throttle, suppressing an immediate periodic call for the same dispatch', () => {
    const throttle = createHeadlineThrottle();
    const dispatch = mockDispatch();
    handleNotification(
      { sessionId: 'own-session', notificationType: 'agent_needs_input' },
      'own-session',
      {
        isWindowFocused: () => false,
        getOpenDispatches: () => [dispatch],
        headlineThrottle: throttle,
        sendHeadline: vi.fn(),
        onUnfocusedNotification: vi.fn(),
      }
    );
    // If bug #1 were still present, recordHeadlineCall was never invoked, so
    // this immediate periodic check would return true (wrongly allowed) and
    // overwrite the blocked headline within the same 15s window.
    expect(shouldCallForHeadline(throttle, dispatch.toolUseId, 'periodic', Date.now())).toBe(false);
  });

  it('does nothing for a notificationType that is not a blocked-trigger type, while still applying the unfocused side effects', () => {
    const sendHeadline = vi.fn();
    const onUnfocused = vi.fn();
    handleNotification(
      { sessionId: 'own-session', notificationType: 'something_else' },
      'own-session',
      {
        isWindowFocused: () => false,
        getOpenDispatches: () => [mockDispatch()],
        headlineThrottle: createHeadlineThrottle(),
        sendHeadline,
        onUnfocusedNotification: onUnfocused,
      }
    );
    expect(sendHeadline).not.toHaveBeenCalled();
    expect(onUnfocused).toHaveBeenCalledWith('something_else');
  });
});
