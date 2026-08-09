import type { CodexAuthStatus } from '../../src/shared/crossEngineTypes';

/** The one and only auth method id Aether will ever send to the adapter.
 *  Exported so `AcpClient.authenticate()` can build its request from this
 *  single constant and tests can assert on the exact wire value. */
export const CHAT_GPT_AUTH_METHOD_ID = 'chat-gpt';

/** The only allowed status. Everything else -- including a value this
 *  union doesn't even name yet -- fails closed by construction: the
 *  comparison is a literal equality check, not a blocklist membership
 *  test, so a new unrecognized status can never accidentally pass.
 *
 *  The status this checks comes from the adapter's real `authentication/status`
 *  method. That method is NOT part of the ACP spec's `AGENT_METHODS` -- it is a
 *  Codex-specific ACP *extension* method the adapter registers by that literal
 *  name (the Codex ACP adapter's dist/index.js:31697, dispatched to
 *  `getAuthenticationStatus()` at index.js:26399). Its result
 *  `type` is one of 'chat-gpt' | 'api-key' | 'gateway' | 'unauthenticated'. */
export function isAllowedAuthStatus(status: CodexAuthStatus | string | null | undefined): status is 'chat-gpt' {
  return status === CHAT_GPT_AUTH_METHOD_ID;
}

/** Second half of the billing-safety invariant, checked BEFORE `authenticate`
 *  is ever sent: the adapter must actually be offering ChatGPT subscription
 *  auth in the `authMethods` it returned from `initialize`. The real adapter
 *  omits `chat-gpt` when `NO_BROWSER` is set in the child env
 *  (`getCodexAuthMethods()`, adapter dist/index.js:25386-25390); it always
 *  offers `api-key` unconditionally, which Aether simply never selects.
 *  If `chat-gpt` is absent we refuse rather than fall back to any other
 *  offered method -- there is deliberately no "pick the first available"
 *  path anywhere in this codebase. */
export function offersChatGptAuthMethod(authMethods: ReadonlyArray<{ id?: unknown }> | null | undefined): boolean {
  return Array.isArray(authMethods) && authMethods.some((m) => m?.id === CHAT_GPT_AUTH_METHOD_ID);
}
