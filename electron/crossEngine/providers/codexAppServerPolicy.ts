import { ProviderError } from './contract';

/** Verified against the pinned CLI's `features list`. Apply both at process
 * startup and thread creation, so project layers cannot re-enable peer tools. */
export const CODEX_SESSION_CONFIG = Object.freeze({
  web_search: 'disabled',
  'features.apps': false,
  'features.plugins': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.skill_mcp_dependency_install': false,
});
export const CODEX_APP_SERVER_ARGS = Object.freeze([
  ...Object.entries(CODEX_SESSION_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
  'app-server',
]);

/** An empty CLI mcp_servers override MERGES rather than clearing stored entries
 * in 0.153.2 (measured with config/read). Refuse enabled servers before creating
 * a thread rather than pretending dedicated CODEX_HOME alone disables peers.
 * This is configuration validation, not filesystem read confinement. */
export function assertNoEnabledMcpServers(response: unknown): void {
  const config = (response as { config?: { mcp_servers?: unknown } } | null)?.config;
  const servers = config?.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new ProviderError('PROTOCOL_ERROR', 'cannot verify provider MCP configuration');
  }
  for (const server of Object.values(servers)) {
    if (!server || typeof server !== 'object' || (server as { enabled?: unknown }).enabled !== false) {
      throw new ProviderError('PROTOCOL_ERROR', 'provider MCP servers must be disabled before consultation');
    }
  }
}
