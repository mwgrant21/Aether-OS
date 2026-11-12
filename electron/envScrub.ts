// Deletes, in place, every key of `env` whose upper-cased name is in `blocked`.
// Windows resolves env names case-insensitively, so `Anthropic_Api_Key` reaches a child just
// like ANTHROPIC_API_KEY; callers pass an already-copied env. Keep in step with scrubbedEnv in
// collector/src/memoryExtract.ts (the collector cannot import from electron).
export function deleteEnvKeysIgnoreCase(env: NodeJS.ProcessEnv, blocked: readonly string[]): void {
  const upper = new Set(blocked.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) if (upper.has(key.toUpperCase())) delete env[key];
}
