// ---------------------------------------------------------------------------
// A resolver map's cleanup timer
// ---------------------------------------------------------------------------
//
// A pending-decision map (requestId -> resolver) needs its stale entry removed
// once the owner's own timeout has made the decision moot. permissionServer.ts
// resolves its HTTP response on timeout WITHOUT ever settling the `decision`
// promise the resolver belongs to, so nothing else ever removes that entry:
// left alone it is a slow, session-lifetime leak of one Function reference per
// timed-out prompt.
//
// This used to take an optional `onExpire` hook so a caller could react to the
// same moment -- specifically, to force-close a user-wait interval for a prompt
// the operator abandoned. That wait clock has been removed (see
// docs/superpowers/specs/2026-09-16-user-wait-subtraction-removal.md), and the
// hook went with it rather than being left dangling for something to be wired
// back into. The +1000ms stagger stays: it keeps this cleanup strictly after
// the server-side timeout that made the entry moot in the first place.
export function scheduleResolverCleanup<T>(
  map: Map<string, (decision: T) => void>,
  requestId: string,
  afterMs: number,
): void {
  setTimeout(() => {
    map.delete(requestId);
  }, afterMs + 1000).unref();
}
