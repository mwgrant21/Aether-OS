// Shared AetherChoice types. Primitives only, no behavior.

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const;
export const LAUNCH_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const MANUAL_ONLY_EFFORTS = ['xhigh', 'max'] as const;

/** The only launchable models. */
export type ModelAlias = (typeof MODEL_ALIASES)[number];
/** Display tiers. fable and design are display-only, never launchable or auto-picked. */
export type TierId = ModelAlias | 'fable' | 'design';
/** What the CLI --effort flag accepts. */
export type LaunchEffort = (typeof LAUNCH_EFFORTS)[number];
export type EffortLevel = LaunchEffort;

export type Pick = { model: ModelAlias; effort: EffortLevel };
export type PickSource = 'auto' | 'manual';
export type TaskClass = 'mechanical' | 'default' | 'judgment';
export type PickTrigger =
  | 'new-thread'
  | 'miss'
  | 'budget'
  | 'task-class'
  | 'think-harder'
  | 'manual';
export type ReadoutState =
  | 'steady'
  | 'queued'
  | 'queuedModel'
  | 'applying'
  | 'blocked'
  | 'notApplied'
  | 'unconfirmed';
