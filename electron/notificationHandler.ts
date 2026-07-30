import type { RealAgentDispatch } from '../src/state/liveAgentsMath';
import { generateHeadline, recordHeadlineCall, type HeadlineThrottle } from './headlineGenerator';

export interface NotificationHandlerDeps {
  isWindowFocused: () => boolean;
  getOpenDispatches: () => RealAgentDispatch[];
  headlineThrottle: HeadlineThrottle;
  apiKey: string | undefined;
  sendHeadline: (toolUseId: string, headline: string) => void;
  // Everything the pre-existing badge/flash/counter suppression path does --
  // stays in main.ts since it's all Electron/mainWindow-specific.
  onUnfocusedNotification: (notificationType: string) => void;
}

// The real Notification hook payload is session-level (no tool_use_id -- see
// docs/superpowers/specs/2026-07-29-presentation-handoff-design.md's
// architecture diagram and permissionServer.ts's onNotification signature),
// so there's no real per-dispatch correlating ID to prefer: apply the
// blocked headline to the most-recently-started currently-open dispatch.
export function selectMostRecentOpenDispatch(openDispatches: RealAgentDispatch[]): RealAgentDispatch | undefined {
  return [...openDispatches].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
}

export function handleNotification(
  event: { sessionId: string; notificationType: string },
  ownSessionId: string | null,
  deps: NotificationHandlerDeps
): void {
  if (event.sessionId !== ownSessionId) return; // fleet noise, not us

  // isWindowFocused gates the ENTIRE handler below -- no exceptions, including
  // the blocked-trigger headline. Final-review bug #2: this check used to sit
  // below the blocked-trigger block, so every permission_prompt/
  // agent_needs_input notification fired an unthrottled Haiku call even during
  // an ordinary focused session. Keep this the very first thing after the
  // session-identity check.
  if (deps.isWindowFocused()) return; // suppression rule: true no-op while focused

  if (event.notificationType === 'agent_needs_input' || event.notificationType === 'permission_prompt') {
    const mostRecentOpen = selectMostRecentOpenDispatch(deps.getOpenDispatches());
    if (mostRecentOpen) {
      generateHeadline(mostRecentOpen, 'blocked', event.notificationType, deps.apiKey).then((headline) => {
        if (headline) {
          deps.sendHeadline(mostRecentOpen.toolUseId, headline);
          // Final-review bug #1: record into the shared throttle map so the
          // periodic loop's shouldCallForHeadline treats this toolUseId as
          // "already handled recently" and doesn't immediately overwrite this
          // headline at its next 15s boundary while still blocked.
          recordHeadlineCall(deps.headlineThrottle, mostRecentOpen.toolUseId, Date.now());
        }
      });
    }
  }

  deps.onUnfocusedNotification(event.notificationType);
}
