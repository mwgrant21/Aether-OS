import type { LaunchEffort, ModelAlias, Pick, ReadoutState } from './types';

export const AETHER_CHOICE_CHANNELS = {
  state: 'aetherChoice:state',
  submit: 'aetherChoice:submit',
  clearHalt: 'aetherChoice:clear-halt',
  halted: 'aetherChoice:halted',
} as const;

export type AetherChoiceSlot = 'claude' | 'terminal2';

export type AetherChoiceSlotState = {
  readout: ReadoutState;
  tier: ModelAlias;
  effort: LaunchEffort;
  reason: string;
  auto: boolean;
  target?: { tier: ModelAlias; effort: LaunchEffort };
  haltedText?: string;
};

export type AetherChoiceState = { claude: AetherChoiceSlotState | null; terminal2: AetherChoiceSlotState | null };
export type AetherChoiceSubmit = { slot: AetherChoiceSlot; model: ModelAlias; effort: LaunchEffort };
export type AetherChoiceSubmitResult = { ok: true } | { ok: false };
export type AetherChoiceClear = { slot: AetherChoiceSlot };
/** Push payload; the renderer only uses it as a trigger to re-pull. */
export type AetherChoiceHalted = { threadId: string; wanted: Pick; actual: Pick | null };
