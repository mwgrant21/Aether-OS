// ---------------------------------------------------------------------------
// A resolver map's cleanup timer, with an optional expiry hook
// ---------------------------------------------------------------------------
//
// A pending-decision map (requestId -> resolver) needs its stale entry
// removed once the owner's own timeout has made the decision moot. `onExpire`
// lets a caller ALSO react to that same moment -- e.g. force-closing some
// other piece of state that would otherwise only ever close when the
// eventual settlement of the decision it's paired with runs its `finally`.
//
// Motivating case (electron/main.ts's onPermissionRequest/onPostToolUse): a
// wait-clock interval opens when a prompt is shown and normally closes in a
// `finally` once the awaited `decision` settles. But permissionServer.ts's
// own timeout resolves its HTTP response WITHOUT ever settling `decision`, so
// if the operator abandons the prompt, that `finally` never runs. Without
// `onExpire` closing the interval here, it would stay open forever -- and
// because an open interval counts as "still waiting" all the way up to
// `nowMs` on every future call, that silently drags every later dispatch's
// measured duration toward zero, not just once but for the rest of the
// process's life. See electron/resolverCleanup.test.ts for the regression
// test pinned to exactly this failure mode.
export function scheduleResolverCleanup<T>(
  map: Map<string, (decision: T) => void>,
  requestId: string,
  afterMs: number,
  onExpire?: () => void,
): void {
  setTimeout(() => {
    map.delete(requestId);
    onExpire?.();
  }, afterMs + 1000).unref();
}
