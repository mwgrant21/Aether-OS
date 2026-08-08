import type { CodexAuthStatus } from '../../src/shared/crossEngineTypes';

/** The only allowed status. Everything else -- including a value this
 *  union doesn't even name yet -- fails closed by construction: the
 *  comparison is a literal equality check, not a blocklist membership
 *  test, so a new unrecognized status can never accidentally pass. */
export function isAllowedAuthStatus(status: CodexAuthStatus | string | null | undefined): status is 'chat-gpt' {
  return status === 'chat-gpt';
}
