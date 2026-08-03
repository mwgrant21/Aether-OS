// The single place every model ID in this app is allowed to be named. No
// other file may declare a model-ID string literal or call
// `client.messages.create` directly -- see modelPolicyEnforcement.test.ts,
// which fails the build if either happens. Features request a tier
// (resolveModel) rather than naming a model, so adding or changing a model
// requires editing this file, which is where a reviewer actually looks.
// See docs/roadmap.md Stage 11.5 for why this module exists.

export type ModelTier = 'chat' | 'headline';
export type ModelPolicyMode = 'Local' | 'API' | 'Off';

const TIER_MODELS: Record<ModelTier, string> = {
  chat: 'claude-opus-4-8',
  headline: 'claude-haiku-4-5',
};

export const ALLOWED_MODELS: readonly string[] = Object.freeze(Object.values(TIER_MODELS));

export function resolveModel(tier: ModelTier): string {
  return TIER_MODELS[tier];
}

// 'Local' is reserved for Stage 12's Ollama detection cascade and is not
// implemented yet -- until then it must behave like 'Off' (no model calls),
// never silently do nothing unexplained. Only 'API' mode makes a real call.
export function isModelCallAllowed(mode: ModelPolicyMode): boolean {
  return mode === 'API';
}
