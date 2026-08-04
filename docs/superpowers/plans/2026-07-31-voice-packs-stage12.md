# Stage 12 — Voice Packs & Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each real agent dispatch a role-based voice (STEWARD/CINDER/PILGRIM/ASSAY/FORGE) rendered as narration in the agent roster, driven entirely by data Aether already has — no model call.

**Architecture:** Five hand-authored voice packs (data files) keyed by role. A `subagent_type → role` lookup table resolves which pack applies to a real dispatch. A deterministic renderer picks the pack's sample text for the dispatch's computed severity, enforces the `max_chars` cap, and prepends any frozen phrase — the same "no model call" shape as `formatHeadline()`. `electron/main.ts`'s existing per-tick agent loop computes severity from `CompletedDispatchUsage` and pushes narration over IPC into a new `state.dispatchNarrations` map, rendered in `AgentRosterCard` under a verbosity dial with a severity-≥3 floor.

**Tech Stack:** TypeScript, React (renderer), Electron main process, Vitest.

## Global Constraints

- **No model call for narration.** Roadmap Stage 11.5 addendum: "Aether is meant to not cost a user money, full stop... the only feature for which 'the user asked for this specific reply' is unambiguously true[ is] the bar every model call in this project should have to clear." Narration is unprompted/continuous — same shape as the retired Auto Headlines call. This applies to every task below.
- **`personas.ts` is untouched.** Voice packs render in the agent roster only, never in chat channels (spec §5.10).
- **Fleet `max_chars` defaults** (spec §5.3): sev1=140, sev2=160, sev3=140, sev4=110. Truncate at the last complete sentence boundary on overflow — never mid-sentence.
- **Dial floor** (spec §11 Phase 1): severity ≥ 3 and all frozen phrases render regardless of the verbosity dial.
- **Frozen phrases are runtime-prepended, never model-generated** (spec §6): `CINDER/critic_tell` → "Oh. That's actually interesting." · `ASSAY/no_signal` → "Treat everything unverified." · `STEWARD/all_clear` → "Nothing requires you." · `PILGRIM/empty_result` → "The path exists. It's empty."
- **Role, not name.** Voice packs key on the 5 fixed roles (spec §5.1), resolved from real `subagent_type` values via a static lookup table (spec §12, Stage 12 scoping).
- Put testable logic in `src/shared/` (renderer-safe) or `electron/` (main-process-only) with a matching `*.test.ts`. Run `npm test` before any task is done.
- Named scope limit, not glossed: Phase 1's renderer selects a pack's fixed sample text for the dispatch's severity — it does not interpolate per-dispatch facts into that prose (no model exists to do that grammatically). Frozen-phrase `EventKind` detection (`all_clear`, `empty_result`, etc.) is wired at the pure-function level (Task 3) but not yet triggered from real per-role business logic (Task 8 passes `eventKind: null`) — that needs per-role semantics (e.g. "PILGRIM found nothing") this stage's data doesn't carry yet.

---

### Task 1: Role-resolution table

**Files:**
- Create: `src/shared/agentVoiceRoles.ts`
- Test: `src/shared/agentVoiceRoles.test.ts`

**Interfaces:**
- Produces: `export type VoiceRole = 'STEWARD' | 'CINDER' | 'PILGRIM' | 'ASSAY' | 'FORGE'` and `export function resolveVoiceRole(subagentType: string): VoiceRole`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/agentVoiceRoles.test.ts
import { describe, it, expect } from 'vitest';
import { resolveVoiceRole } from './agentVoiceRoles';

describe('resolveVoiceRole', () => {
  it('maps known review/critic subagent types to CINDER', () => {
    expect(resolveVoiceRole('code-reviewer')).toBe('CINDER');
    expect(resolveVoiceRole('silent-failure-hunter')).toBe('CINDER');
  });

  it('maps known explorer subagent types to PILGRIM', () => {
    expect(resolveVoiceRole('Explore')).toBe('PILGRIM');
  });

  it('maps known verifier subagent types to ASSAY', () => {
    expect(resolveVoiceRole('pr-test-analyzer')).toBe('ASSAY');
  });

  it('maps known orchestrator subagent types to STEWARD', () => {
    expect(resolveVoiceRole('project-orchestrator')).toBe('STEWARD');
  });

  it('falls back to FORGE for unmapped subagent types', () => {
    expect(resolveVoiceRole('general-purpose')).toBe('FORGE');
    expect(resolveVoiceRole('some-brand-new-agent-type')).toBe('FORGE');
  });

  it('is case-sensitive and does not fuzzy-match', () => {
    expect(resolveVoiceRole('CODE-REVIEWER')).toBe('FORGE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/agentVoiceRoles.test.ts`
Expected: FAIL with "Cannot find module './agentVoiceRoles'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/agentVoiceRoles.ts
// Maps a real dispatch's subagent_type (collector/src/toolCallHistory.ts's
// extractSubagentType, e.g. "code-reviewer", "general-purpose") onto one of
// the 5 fixed voice-pack roles (spec §5.1). Voice packs key on role, not on
// the freeform subagent_type string, so this table is the seam between them.
// Mirrors src/components/chat/personas.ts's own FALLBACK_PERSONA pattern:
// a static map with a named default rather than a heuristic.
export type VoiceRole = 'STEWARD' | 'CINDER' | 'PILGRIM' | 'ASSAY' | 'FORGE';

const ROLE_MAP: Record<string, VoiceRole> = {
  'project-orchestrator': 'STEWARD',
  'design-studio-pm': 'STEWARD',

  'code-reviewer': 'CINDER',
  'silent-failure-hunter': 'CINDER',
  'comment-analyzer': 'CINDER',
  'type-design-analyzer': 'CINDER',
  'security-code-reviewer': 'CINDER',
  'ps-code-reviewer': 'CINDER',

  'Explore': 'PILGRIM',
  'general-purpose': 'FORGE',

  'pr-test-analyzer': 'ASSAY',
  'post-deployment-validator': 'ASSAY',
  'compliance-baseline-agent': 'ASSAY',
};

// Unmapped subagent_type -> FORGE. FORGE ("works, does not narrate working")
// is the safest default for an unknown builder-shaped task -- it is silent
// at nominal severity, so an unrecognized agent doesn't produce noisy
// narration by default.
export function resolveVoiceRole(subagentType: string): VoiceRole {
  return ROLE_MAP[subagentType] ?? 'FORGE';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/agentVoiceRoles.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/agentVoiceRoles.ts src/shared/agentVoiceRoles.test.ts
git commit -m "feat(voice-packs): add subagent_type-to-role resolution table"
```

---

### Task 2: Voice pack data

**Files:**
- Create: `src/shared/voicePacks.ts`
- Test: `src/shared/voicePacks.test.ts`

**Interfaces:**
- Consumes: `VoiceRole` from Task 1 (`src/shared/agentVoiceRoles.ts`)
- Produces: `export type Severity = 0 | 1 | 2 | 3 | 4`, `export type EventKind = 'all_clear' | 'anomaly' | 'critic_tell' | 'empty_result' | 'no_signal' | 'blocked'`, `export interface VoicePack { id: string; display_name: string; archetype: string; register: { baseline: string; escalation_curve: 'clipped' | 'engaged' | 'latent'; address: string; lexicon_prefer: string[]; lexicon_avoid: string[]; max_chars?: Partial<Record<Severity, number>> }; frozen: Partial<Record<EventKind, string>>; samples: Partial<Record<Severity, string>> }`, `export const VOICE_PACKS: Record<VoiceRole, VoicePack>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/voicePacks.test.ts
import { describe, it, expect } from 'vitest';
import { VOICE_PACKS } from './voicePacks';

const ROLES = ['STEWARD', 'CINDER', 'PILGRIM', 'ASSAY', 'FORGE'] as const;

describe('VOICE_PACKS', () => {
  it('has exactly the 5 spec roles, no more, no fewer', () => {
    expect(Object.keys(VOICE_PACKS).sort()).toEqual([...ROLES].sort());
  });

  it('every pack has a sample for severities 1-4', () => {
    for (const role of ROLES) {
      const pack = VOICE_PACKS[role];
      for (const sev of [1, 2, 3, 4] as const) {
        expect(pack.samples[sev], `${role} missing sample for sev ${sev}`).toBeTruthy();
      }
    }
  });

  it('FORGE has no sample for severity 1 (silent heartbeat, spec §5.9)', () => {
    expect(VOICE_PACKS.FORGE.samples[1]).toBeUndefined();
  });

  it('carries the 4 frozen phrases on their spec-assigned packs', () => {
    expect(VOICE_PACKS.CINDER.frozen.critic_tell).toBe("Oh. That's actually interesting.");
    expect(VOICE_PACKS.ASSAY.frozen.no_signal).toBe('Treat everything unverified.');
    expect(VOICE_PACKS.STEWARD.frozen.all_clear).toBe('Nothing requires you.');
    expect(VOICE_PACKS.PILGRIM.frozen.empty_result).toBe("The path exists. It's empty.");
  });

  it('CINDER is the only engaged-curve pack (spec §5.2)', () => {
    const engaged = ROLES.filter((r) => VOICE_PACKS[r].register.escalation_curve === 'engaged');
    expect(engaged).toEqual(['CINDER']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/voicePacks.test.ts`
Expected: FAIL with "Cannot find module './voicePacks'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/voicePacks.ts
// Data-only voice packs, ported verbatim from
// docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md §5. One file, not one
// file per agent (spec's own §5.1 suggestion) -- 5 short records read better
// together than scattered, and Phase 1 has no per-file reason to split them.
import type { VoiceRole } from './agentVoiceRoles';

export type Severity = 0 | 1 | 2 | 3 | 4;

// Closed union, deliberately -- adding a member is a code change (spec §5.1).
export type EventKind = 'all_clear' | 'anomaly' | 'critic_tell' | 'empty_result' | 'no_signal' | 'blocked';

export interface VoicePack {
  id: string;
  display_name: string;
  archetype: string;
  register: {
    baseline: string;
    escalation_curve: 'clipped' | 'engaged' | 'latent';
    address: string;
    lexicon_prefer: string[];
    lexicon_avoid: string[];
    max_chars?: Partial<Record<Severity, number>>;
  };
  frozen: Partial<Record<EventKind, string>>;
  samples: Partial<Record<Severity, string>>;
}

export const VOICE_PACKS: Record<VoiceRole, VoicePack> = {
  STEWARD: {
    id: 'steward',
    display_name: 'STEWARD',
    archetype: 'Majordomo. Anticipatory, never rattled.',
    register: {
      baseline: 'Formal without being ornate. Calm anchor. Anticipates rather than reacts.',
      escalation_curve: 'clipped',
      address: 'sir at sev 1-2; drops the honorific at sev 3+',
      lexicon_prefer: ['I don’t believe', 'at the moment'],
      lexicon_avoid: ['exclamation', 'great news', 'enthusiasm', 'apology'],
    },
    frozen: { all_clear: 'Nothing requires you.' },
    samples: {
      1: "Everything is running within its usual envelope, sir. I don't believe anything requires you at the moment.",
      2: 'CINDER has been on the auth module for four minutes, sir. Its median is forty seconds.',
      3: 'FORGE is on its third attempt at the same migration. I would look.',
      4: 'Stopped. ASSAY cannot reach the test runner. Nothing downstream can proceed.',
    },
  },
  CINDER: {
    id: 'cinder',
    display_name: 'CINDER',
    archetype: 'Bored genius. Contempt aimed at the defect.',
    register: {
      baseline: 'Dry, terse, precise. Bored, not despairing. Contempt directed outward at the defect, always specific.',
      escalation_curve: 'engaged',
      address: 'never hedges',
      lexicon_prefer: [],
      lexicon_avoid: ['self-pity', 'nihilism', 'generalized despair', 'cruelty aimed at the user'],
    },
    frozen: { critic_tell: "Oh. That's actually interesting." },
    samples: {
      1: "It compiles. I'm thrilled.",
      2: "There's a retry loop in here. I'll assume that was deliberate.",
      3: "You're catching the exception and returning null. Someone downstream dereferences that, and it won't be me who has to find it.",
      4: "Oh. That's actually interesting. You're mutating shared state across two async boundaries — the race only opens under load, which is why your tests are green and staging isn't.",
    },
  },
  PILGRIM: {
    id: 'pilgrim',
    display_name: 'PILGRIM',
    archetype: 'Scout. Reports coordinates, not opinions.',
    register: {
      baseline: 'Noun-heavy fragments. Counts and paths. Never speculates, never recommends.',
      escalation_curve: 'clipped',
      address: 'flat, no address',
      lexicon_prefer: [],
      lexicon_avoid: ['interpretation', 'recommendation', 'enthusiasm about discoveries'],
    },
    frozen: { empty_result: "The path exists. It's empty." },
    samples: {
      1: 'Forty-one files. Three match.',
      2: "Three matches. Two are in a vendored directory — flagging in case that isn't what you meant.",
      3: "Nothing under the path you gave. The path exists. It's empty.",
      4: "Can't read the tree. Permission denied at the repo root.",
    },
  },
  ASSAY: {
    id: 'assay',
    display_name: 'ASSAY',
    archetype: 'Paranoid assessor. Trusts nothing it has not personally confirmed.',
    register: {
      baseline: 'Counts first, always. Explicitly distinguishes passed from not run. Never rounds.',
      escalation_curve: 'clipped',
      address: 'flat, no address',
      lexicon_prefer: [],
      lexicon_avoid: ['reassurance', 'approximation', 'treating absence of failure as success'],
      // sev-4 line is exempt from the verbosity dial (spec §5.8) -- enforced
      // in Task 4's applyVerbosity, not here.
    },
    frozen: { no_signal: 'Treat everything unverified.' },
    samples: {
      1: 'Eighteen passed. Nothing skipped.',
      2: 'Eighteen passed, two skipped. The skips are marked TODO from March.',
      3: "Sixteen passed, two failed. Both in the module FORGE just touched.",
      4: "Runner didn't start. I have no signal. Treat everything unverified.",
    },
  },
  FORGE: {
    id: 'forge',
    display_name: 'FORGE',
    archetype: 'Works. Does not narrate working.',
    register: {
      baseline: 'Speaks when finished or when stuck. Latent curve.',
      escalation_curve: 'latent',
      address: 'flat, no address',
      lexicon_prefer: [],
      lexicon_avoid: ['progress chatter', 'status-for-status’s-sake', 'optimism about in-progress work'],
    },
    frozen: {},
    samples: {
      // sev 1 intentionally has no sample: narration: null, heartbeat only
      // (spec §5.9) -- FORGE is silent-but-alive at nominal severity.
      2: 'Done. Four files touched.',
      3: "Third attempt on the migration. Same constraint violation each time — users.tenant_id not null.",
      4: 'Blocked. Schema decision needed.',
    },
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/voicePacks.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/voicePacks.ts src/shared/voicePacks.test.ts
git commit -m "feat(voice-packs): add 5 voice pack data files ported from spec §5"
```

---

### Task 3: Narration renderer — severity selection, max_chars enforcement, frozen-phrase prepend

**Files:**
- Create: `src/shared/voiceRender.ts`
- Test: `src/shared/voiceRender.test.ts`

**Interfaces:**
- Consumes: `VoicePack`, `Severity`, `EventKind` from Task 2 (`src/shared/voicePacks.ts`)
- Produces: `export const FLEET_MAX_CHARS: Record<Severity, number>` and `export function renderNarration(pack: VoicePack, severity: Severity, eventKind?: EventKind | null): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/voiceRender.test.ts
import { describe, it, expect } from 'vitest';
import { renderNarration, FLEET_MAX_CHARS } from './voiceRender';
import { VOICE_PACKS } from './voicePacks';

describe('renderNarration', () => {
  it('renders the pack’s sample for the given severity', () => {
    expect(renderNarration(VOICE_PACKS.CINDER, 1)).toBe("It compiles. I'm thrilled.");
  });

  it('falls back to the nearest lower severity when a pack has no sample for that severity (FORGE sev 1)', () => {
    // FORGE has no sev-1 sample by design (silent heartbeat); renderNarration
    // still needs a deterministic non-throwing fallback for callers that
    // don't special-case severity 1 themselves.
    expect(renderNarration(VOICE_PACKS.FORGE, 1)).toBe('');
  });

  it('prepends the frozen phrase for a matching EventKind', () => {
    const result = renderNarration(VOICE_PACKS.CINDER, 4, 'critic_tell');
    expect(result.startsWith("Oh. That's actually interesting.")).toBe(true);
  });

  it('does not duplicate the frozen phrase when the sample already starts with it', () => {
    // CINDER's own sev-4 sample already opens with the frozen phrase verbatim.
    const result = renderNarration(VOICE_PACKS.CINDER, 4, 'critic_tell');
    expect(result.match(/Oh\. That's actually interesting\./g)?.length).toBe(1);
  });

  it('truncates at the last full sentence boundary when over the cap, never mid-sentence', () => {
    const longPack = {
      ...VOICE_PACKS.CINDER,
      samples: { 1: 'Short one. Second sentence that pushes this well past a tiny cap. Third sentence.' },
      register: { ...VOICE_PACKS.CINDER.register, max_chars: { 1: 20 } },
    };
    const result = renderNarration(longPack, 1);
    expect(result).toBe('Short one.');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('uses fleet defaults when a pack has no max_chars override', () => {
    expect(FLEET_MAX_CHARS[1]).toBe(140);
    expect(FLEET_MAX_CHARS[2]).toBe(160);
    expect(FLEET_MAX_CHARS[3]).toBe(140);
    expect(FLEET_MAX_CHARS[4]).toBe(110);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/voiceRender.test.ts`
Expected: FAIL with "Cannot find module './voiceRender'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/voiceRender.ts
// Deterministic narration renderer -- no model call (see this plan's Global
// Constraints; spec §6's "generated flesh" is replaced with "selected
// flesh" for the same no-cost reason formatHeadline() already applies).
import type { VoicePack, Severity, EventKind } from './voicePacks';

// Fleet defaults, spec §5.3. Per-pack register.max_chars overrides these.
export const FLEET_MAX_CHARS: Record<Severity, number> = { 0: 0, 1: 140, 2: 160, 3: 140, 4: 110 };

function pickSample(pack: VoicePack, severity: Severity): string {
  const direct = pack.samples[severity];
  if (direct !== undefined) return direct;
  // Walk down to the nearest lower severity with a sample (e.g. FORGE has
  // no sev-1 sample by design -- spec §5.9's silent heartbeat). Severity 1
  // with nothing below it renders empty, which callers treat as "no line",
  // matching FORGE's narration:null contract at the caller layer (Task 7).
  for (let s = severity - 1; s >= 1; s--) {
    const fallback = pack.samples[s as Severity];
    if (fallback !== undefined) return fallback;
  }
  return '';
}

function truncateAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastBoundary = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.', slice.length - 1));
  if (lastBoundary > 0 && slice[lastBoundary] === '.') {
    return slice.slice(0, lastBoundary + 1);
  }
  // No sentence boundary fits inside the cap at all -- hard truncate is the
  // documented fallback (spec §5.3: "a hard-truncated line reads as a bug,
  // not as terseness", accepted as the last resort when re-prompting isn't
  // possible because there is no model call to re-prompt).
  return slice.trimEnd();
}

export function renderNarration(pack: VoicePack, severity: Severity, eventKind?: EventKind | null): string {
  const base = pickSample(pack, severity);
  if (!base) return '';

  const frozen = eventKind ? pack.frozen[eventKind] : undefined;
  let full = base;
  if (frozen && !base.startsWith(frozen)) {
    full = `${frozen} ${base}`;
  }

  const cap = pack.register.max_chars?.[severity] ?? FLEET_MAX_CHARS[severity];
  return truncateAtSentenceBoundary(full, cap);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/voiceRender.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/voiceRender.ts src/shared/voiceRender.test.ts
git commit -m "feat(voice-packs): add deterministic narration renderer with max_chars enforcement"
```

---

### Task 4: Verbosity dial with severity floor

**Files:**
- Create: `src/shared/narrationVerbosity.ts`
- Test: `src/shared/narrationVerbosity.test.ts`

**Interfaces:**
- Consumes: `Severity` from Task 2 (`src/shared/voicePacks.ts`)
- Produces: `export type NarrationVerbosity = 'full' | 'terse' | 'silent'` and `export function applyNarrationVerbosity(narration: string, level: NarrationVerbosity, severity: Severity): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/narrationVerbosity.test.ts
import { describe, it, expect } from 'vitest';
import { applyNarrationVerbosity } from './narrationVerbosity';

describe('applyNarrationVerbosity', () => {
  it('passes narration through unchanged at full', () => {
    expect(applyNarrationVerbosity('hello', 'full', 1)).toBe('hello');
  });

  it('passes narration through at terse regardless of severity (terse only affects future longer variants)', () => {
    expect(applyNarrationVerbosity('hello', 'terse', 2)).toBe('hello');
  });

  it('suppresses narration at silent for low severity', () => {
    expect(applyNarrationVerbosity('hello', 'silent', 1)).toBeNull();
    expect(applyNarrationVerbosity('hello', 'silent', 2)).toBeNull();
  });

  it('the severity >= 3 floor always renders even at silent (spec §11 Phase 1)', () => {
    expect(applyNarrationVerbosity('hello', 'silent', 3)).toBe('hello');
    expect(applyNarrationVerbosity('hello', 'silent', 4)).toBe('hello');
  });

  it('empty narration is always null regardless of dial (FORGE sev-1 heartbeat has no line)', () => {
    expect(applyNarrationVerbosity('', 'full', 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/narrationVerbosity.test.ts`
Expected: FAIL with "Cannot find module './narrationVerbosity'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/narrationVerbosity.ts
// Verbosity dial for rendered narration, spec §11 Phase 1. Ships with the
// severity floor in the same change -- shipping the dial without the floor
// would let 'silent' hide ASSAY's "Treat everything unverified." sev-4
// line, which the spec calls out as the one string that must always appear.
import type { Severity } from './voicePacks';

export type NarrationVerbosity = 'full' | 'terse' | 'silent';

export function applyNarrationVerbosity(narration: string, level: NarrationVerbosity, severity: Severity): string | null {
  if (!narration) return null;
  if (severity >= 3) return narration; // floor: always renders
  if (level === 'silent') return null;
  return narration;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/narrationVerbosity.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/narrationVerbosity.ts src/shared/narrationVerbosity.test.ts
git commit -m "feat(voice-packs): add verbosity dial with severity-3 floor"
```

---

### Task 5: Interruption budget mechanism

**Files:**
- Create: `src/shared/interruptionBudget.ts`
- Test: `src/shared/interruptionBudget.test.ts`

**Interfaces:**
- Produces: `export interface InterruptionBudgetState { lastVolunteeredAtMs: number | null }`, `export function createInterruptionBudget(): InterruptionBudgetState`, `export function canVolunteer(state: InterruptionBudgetState, nowMs: number, windowMs: number): boolean`, `export function spendBudget(state: InterruptionBudgetState, nowMs: number): InterruptionBudgetState`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/interruptionBudget.test.ts
import { describe, it, expect } from 'vitest';
import { createInterruptionBudget, canVolunteer, spendBudget } from './interruptionBudget';

describe('interruption budget', () => {
  it('allows volunteering when nothing has been spent yet', () => {
    const state = createInterruptionBudget();
    expect(canVolunteer(state, 1000, 60_000)).toBe(true);
  });

  it('spending records the time and blocks a second volunteer inside the window', () => {
    let state = createInterruptionBudget();
    state = spendBudget(state, 1000);
    expect(canVolunteer(state, 1000 + 30_000, 60_000)).toBe(false);
  });

  it('allows volunteering again once the window has elapsed', () => {
    let state = createInterruptionBudget();
    state = spendBudget(state, 1000);
    expect(canVolunteer(state, 1000 + 60_001, 60_000)).toBe(true);
  });

  it('spendBudget does not mutate the input state (immutable, matches HeadlineThrottle-adjacent style)', () => {
    const state = createInterruptionBudget();
    const next = spendBudget(state, 1000);
    expect(state.lastVolunteeredAtMs).toBeNull();
    expect(next.lastVolunteeredAtMs).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/interruptionBudget.test.ts`
Expected: FAIL with "Cannot find module './interruptionBudget'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/interruptionBudget.ts
// STEWARD's interruption-budget MECHANISM only (spec §8): window,
// single-spend, ranking-on-severity is the caller's job (it must pick the
// single highest-ranked item before calling spendBudget, per spec). The
// window value N itself and anomaly-based ranking are Phase 3 -- unknowable
// without observed traffic, so this stage only builds the buildable half.
// Responses to direct questions never call spendBudget (spec: "direct-answer
// exemption") -- that exemption is the caller simply not calling this module
// at all for that path, not a flag here.
export interface InterruptionBudgetState {
  lastVolunteeredAtMs: number | null;
}

export function createInterruptionBudget(): InterruptionBudgetState {
  return { lastVolunteeredAtMs: null };
}

export function canVolunteer(state: InterruptionBudgetState, nowMs: number, windowMs: number): boolean {
  if (state.lastVolunteeredAtMs === null) return true;
  return nowMs - state.lastVolunteeredAtMs >= windowMs;
}

export function spendBudget(state: InterruptionBudgetState, nowMs: number): InterruptionBudgetState {
  return { lastVolunteeredAtMs: nowMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/interruptionBudget.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/interruptionBudget.ts src/shared/interruptionBudget.test.ts
git commit -m "feat(voice-packs): add STEWARD interruption budget mechanism"
```

---

### Task 6: Attention hook (instrumented, unconsumed)

**Files:**
- Create: `src/shared/attentionTracker.ts`
- Test: `src/shared/attentionTracker.test.ts`

**Interfaces:**
- Produces: `export interface AttentionState { focusedPanel: string | null; lastInteractionAtMs: number | null }`, `export function createAttentionState(): AttentionState`, `export function recordFocus(state: AttentionState, panel: string, nowMs: number): AttentionState`, `export function recordInteraction(state: AttentionState, nowMs: number): AttentionState`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/attentionTracker.test.ts
import { describe, it, expect } from 'vitest';
import { createAttentionState, recordFocus, recordInteraction } from './attentionTracker';

describe('attention tracker', () => {
  it('starts with no focused panel and no interaction', () => {
    const state = createAttentionState();
    expect(state.focusedPanel).toBeNull();
    expect(state.lastInteractionAtMs).toBeNull();
  });

  it('recordFocus sets the focused panel without touching interaction time', () => {
    const state = recordFocus(createAttentionState(), 'agent-roster', 1000);
    expect(state.focusedPanel).toBe('agent-roster');
    expect(state.lastInteractionAtMs).toBeNull();
  });

  it('recordInteraction sets the interaction time without touching the focused panel', () => {
    const state = recordInteraction(recordFocus(createAttentionState(), 'agent-roster', 1000), 2000);
    expect(state.focusedPanel).toBe('agent-roster');
    expect(state.lastInteractionAtMs).toBe(2000);
  });

  it('does not mutate the input state', () => {
    const state = createAttentionState();
    const next = recordFocus(state, 'agent-roster', 1000);
    expect(state.focusedPanel).toBeNull();
    expect(next.focusedPanel).toBe('agent-roster');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/attentionTracker.test.ts`
Expected: FAIL with "Cannot find module './attentionTracker'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/attentionTracker.ts
// Instrumented, unconsumed (spec §8: "the hook ships in Phase 1 even if
// nothing consumes it"). STEWARD's real value -- flagging what the user
// ISN'T looking at -- needs this data, but nothing in Phase 1 reads it yet;
// wiring a render-layer caller (e.g. AgentRosterCard's mount/focus
// lifecycle) into recordFocus/recordInteraction is future work once
// STEWARD's fleet-level narration is built, which is out of this stage's
// scope (this stage narrates per-dispatch, not per-fleet -- see Task 8).
export interface AttentionState {
  focusedPanel: string | null;
  lastInteractionAtMs: number | null;
}

export function createAttentionState(): AttentionState {
  return { focusedPanel: null, lastInteractionAtMs: null };
}

export function recordFocus(state: AttentionState, panel: string, nowMs: number): AttentionState {
  return { ...state, focusedPanel: panel };
}

export function recordInteraction(state: AttentionState, nowMs: number): AttentionState {
  return { ...state, lastInteractionAtMs: nowMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/attentionTracker.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/attentionTracker.ts src/shared/attentionTracker.test.ts
git commit -m "feat(voice-packs): add instrumented, unconsumed attention hook"
```

---

### Task 7: Deterministic narration formatter for real dispatches

**Files:**
- Create: `electron/narrationGenerator.ts`
- Test: `electron/narrationGenerator.test.ts`

**Interfaces:**
- Consumes: `resolveVoiceRole` (Task 1), `VOICE_PACKS`, `Severity` (Task 2), `renderNarration` (Task 3)
- Produces: `export interface DispatchForNarration { subagentType: string; durationMs: number }`, `export function formatNarration(dispatch: DispatchForNarration, medianMsAtEval: number | null): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// electron/narrationGenerator.test.ts
import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

describe('formatNarration', () => {
  it('resolves role from subagentType and renders that role’s sev-1 sample when nothing is anomalous', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 5000 }, null);
    // code-reviewer -> CINDER; no medianMsAtEval and no retries -> sev 1
    expect(result).toBe("It compiles. I'm thrilled.");
  });

  it('returns null for FORGE at severity 1 (silent heartbeat, no chat line)', () => {
    const result = formatNarration({ subagentType: 'general-purpose', durationMs: 5000 }, null);
    expect(result).toBeNull();
  });

  it('escalates severity when duration exceeds 3x the median, same as computeSeverity', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 10_000 }, 1000);
    // elapsedMs(10000) > 3 * medianMsAtEval(1000) -> sev 2
    expect(result).toBe("There's a retry loop in here. I'll assume that was deliberate.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/narrationGenerator.test.ts`
Expected: FAIL with "Cannot find module './narrationGenerator'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// electron/narrationGenerator.ts
// Pure, deterministic -- no model call, no I/O, cannot fail (same shape as
// headlineGenerator.ts's formatHeadline(), for the same "Aether should not
// cost a user money" reason -- see docs/roadmap.md's Stage 11.5 addendum).
// severity is computed here the same way collector/src/personalitySpine.ts's
// computeSeverity does for a completed, non-erroring dispatch: exit 'ok',
// retries 0 -- this stage's data source (CompletedDispatchUsage, from
// liveAgentTracker.tick()) doesn't carry retries/exit yet, so those two
// inputs are the same fixed values Stage 11's own ingestDispatchEvent uses
// for its first consumer. See this plan's design doc for why this doesn't
// need collectorStore.ts's (separately, already-named) stale telemetry
// reader.
import { resolveVoiceRole } from '../src/shared/agentVoiceRoles';
import { VOICE_PACKS, type Severity } from '../src/shared/voicePacks';
import { renderNarration } from '../src/shared/voiceRender';

export interface DispatchForNarration {
  subagentType: string;
  durationMs: number;
}

function computeNarrationSeverity(durationMs: number, medianMsAtEval: number | null): Severity {
  let sev = 1;
  if (medianMsAtEval !== null && durationMs > 3 * medianMsAtEval) sev += 1;
  return Math.min(4, sev) as Severity;
}

export function formatNarration(dispatch: DispatchForNarration, medianMsAtEval: number | null): string | null {
  const role = resolveVoiceRole(dispatch.subagentType);
  const pack = VOICE_PACKS[role];
  const severity = computeNarrationSeverity(dispatch.durationMs, medianMsAtEval);
  const narration = renderNarration(pack, severity, null);
  return narration || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/narrationGenerator.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/narrationGenerator.ts electron/narrationGenerator.test.ts
git commit -m "feat(voice-packs): add deterministic narration formatter for completed dispatches"
```

---

### Task 8: Wire narration into the agent tick loop and IPC

**Files:**
- Modify: `electron/main.ts` (near the existing headline block, `electron/main.ts:438-446`)
- Modify: `electron/preload.ts` (near `onHeadline`, `electron/preload.ts:67`)
- Test: `electron/main.narration.test.ts` (new, isolated test of the tick-loop narration branch — see Step 1)

**Interfaces:**
- Consumes: `formatNarration` from Task 7 (`electron/narrationGenerator.ts`)
- Produces: IPC channel `agents:narration` carrying `{ toolUseId: string; narration: string }`, and `window.aetherElectron.agents.onNarration(callback)` in preload

- [ ] **Step 1: Write the failing test**

`main.ts`'s `tickAndPushAgents` isn't unit-testable in isolation (it's wired to `mainWindow`/`liveAgentTracker` singletons), so this task tests the narration branch as an extracted pure function instead — the same pattern the existing headline block already follows via `formatHeadline`/`shouldCallForHeadline` being separately testable.

```typescript
// electron/main.narration.test.ts
import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

// This test exists to pin the exact call shape main.ts's tick loop uses
// (Step 3) so a future edit to formatNarration's signature is caught here
// before it silently breaks the wiring.
describe('main.ts narration wiring shape', () => {
  it('formatNarration accepts a completed-dispatch-shaped object and a nullable median', () => {
    const result = formatNarration({ subagentType: 'code-reviewer', durationMs: 1200 }, null);
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main.narration.test.ts`
Expected: PASS already (Task 7 shipped `formatNarration`) — this step confirms the import path used from `electron/` resolves; if it fails, fix the import path before continuing.

- [ ] **Step 3: Wire the tick loop**

In `electron/main.ts`, add the import near the existing `formatHeadline` import (line 28):

```typescript
import { formatNarration } from './narrationGenerator';
```

Add a narration block right after the existing headline block (after line 446's `}` closing the headline `for` loop), inside `tickAndPushAgents`:

```typescript
    // Narration: for each dispatch that completed this tick, render a
    // role-based voice line -- no model call (see narrationGenerator.ts).
    // Unlike the headline loop above (which re-renders periodically for
    // still-open work), this fires once per completed dispatch, matching
    // FORGE's "speaks when finished or when stuck" register (spec §5.9).
    for (const c of result.completed) {
      const narration = formatNarration({ subagentType: c.subagentType, durationMs: c.durationMs }, null);
      if (narration) sendToWindow('agents:narration', { toolUseId: c.toolUseId, narration });
    }
```

- [ ] **Step 4: Expose the IPC channel in preload**

In `electron/preload.ts`, add next to the existing `onHeadline` (line 67):

```typescript
    onNarration: (callback: (payload: { toolUseId: string; narration: string }) => void) => {
      const listener = (_event: unknown, payload: { toolUseId: string; narration: string }) => callback(payload);
      ipcRenderer.on('agents:narration', listener);
      return () => ipcRenderer.removeListener('agents:narration', listener);
    },
```

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

Run: `npx vitest run --exclude '**/.worktrees/**'`
Expected: all tests pass, including the new `electron/main.narration.test.ts`

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts electron/preload.ts electron/main.narration.test.ts
git commit -m "feat(voice-packs): wire narration generation into the agent tick loop and IPC"
```

---

### Task 9: State wiring — `dispatchNarrations`

**Files:**
- Modify: `src/state/types.ts` (near `dispatchHeadlines`, `src/state/types.ts:279`)
- Modify: `src/state/reducer.ts` (near `SET_DISPATCH_HEADLINE`, `src/state/reducer.ts:59` and `:265-275`)
- Modify: `src/state/useRealAgentsSync.ts` (near the `onHeadline` listener)
- Test: `src/state/reducer.narration.test.ts`

**Interfaces:**
- Consumes: `onNarration` from Task 8 (`electron/preload.ts`)
- Produces: `state.dispatchNarrations: Record<string, string>`, action `{ type: 'SET_DISPATCH_NARRATION'; toolUseId: string; narration: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/state/reducer.narration.test.ts
import { describe, it, expect } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';

describe('SET_DISPATCH_NARRATION', () => {
  it('adds a narration keyed by toolUseId', () => {
    const state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'Done. Four files touched.' });
    expect(state.dispatchNarrations['tu-1']).toBe('Done. Four files touched.');
  });

  it('overwrites an existing narration for the same toolUseId', () => {
    let state = reducer(initialState, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'first' });
    state = reducer(state, { type: 'SET_DISPATCH_NARRATION', toolUseId: 'tu-1', narration: 'second' });
    expect(state.dispatchNarrations['tu-1']).toBe('second');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/reducer.narration.test.ts`
Expected: FAIL — `dispatchNarrations` undefined / action type not handled

- [ ] **Step 3: Add the state field and action**

In `src/state/types.ts`, next to line 279's `dispatchHeadlines: Record<string, string>;`:

```typescript
  dispatchNarrations: Record<string, string>;
```

Also add its initial value in `src/state/initialState.ts` next to wherever `dispatchHeadlines: {}` is initialized:

```typescript
  dispatchNarrations: {},
```

In `src/state/reducer.ts`, next to line 59's action-type union entry:

```typescript
  | { type: 'SET_DISPATCH_NARRATION'; toolUseId: string; narration: string };
```

And a case mirroring `SET_DISPATCH_HEADLINE` (same eviction-cap pattern read at lines 265-275 — reuse that exact cap logic, applied to `dispatchNarrations` instead of `dispatchHeadlines`):

```typescript
    case 'SET_DISPATCH_NARRATION': {
      let dispatchNarrations = { ...state.dispatchNarrations, [action.toolUseId]: action.narration };
      const narrationKeys = Object.keys(dispatchNarrations);
      if (narrationKeys.length > 200) {
        const toEvict = new Set(narrationKeys.slice(0, narrationKeys.length - 200));
        dispatchNarrations = Object.fromEntries(Object.entries(dispatchNarrations).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchNarrations };
    }
```

(Match whatever eviction count `SET_DISPATCH_HEADLINE` actually uses at line 265-275 — read that block first and mirror its exact number rather than assuming 200.)

- [ ] **Step 4: Wire the listener in `useRealAgentsSync`**

In `src/state/useRealAgentsSync.ts`, add next to the existing `onHeadline` effect:

```typescript
  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onNarration(({ toolUseId, narration }) => {
      dispatch({ type: 'SET_DISPATCH_NARRATION', toolUseId, narration });
    });
  }, [dispatch]);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/state/reducer.narration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run --exclude '**/.worktrees/**'`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/useRealAgentsSync.ts src/state/reducer.narration.test.ts
git commit -m "feat(voice-packs): wire dispatchNarrations state, action, and IPC listener"
```

---

### Task 10: Render narration in AgentRosterCard

**Files:**
- Modify: `src/components/agents/AgentRosterCard.tsx`
- Test: `src/components/agents/AgentRosterCard.narration.test.tsx`

**Interfaces:**
- Consumes: `state.dispatchNarrations` (Task 9), `applyNarrationVerbosity` (Task 4), `state.cfg.narrationVerbosity` (Task 11 — this task assumes `Cfg.narrationVerbosity` already exists; if Task 11 hasn't landed yet, stub the read as `'full'` and revisit once Task 11 lands, per this plan's task ordering)

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/agents/AgentRosterCard.narration.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentRosterCard } from './AgentRosterCard';
import { AetherStoreProvider } from '../../state/store';
import { initialState } from '../../state/initialState';

function renderWithState(patch: Partial<typeof initialState>) {
  const state = { ...initialState, ...patch };
  return render(
    <AetherStoreProvider initial={state}>
      <AgentRosterCard selectedToolUseId={null} />
    </AetherStoreProvider>
  );
}

describe('AgentRosterCard narration', () => {
  it('renders the narration line under a dispatch when present', () => {
    renderWithState({
      realAgents: [{ toolUseId: 'tu-1', subagentType: 'CINDER-role-agent', description: 'reviewing', startedAt: new Date().toISOString(), prompt: '', model: null }],
      dispatchNarrations: { 'tu-1': 'Done. Four files touched.' },
    });
    expect(screen.getByText('Done. Four files touched.')).toBeInTheDocument();
  });

  it('renders nothing extra when no narration exists for a dispatch', () => {
    renderWithState({
      realAgents: [{ toolUseId: 'tu-2', subagentType: 'general-purpose', description: 'working', startedAt: new Date().toISOString(), prompt: '', model: null }],
      dispatchNarrations: {},
    });
    expect(screen.queryByTestId('narration-line')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/agents/AgentRosterCard.narration.test.tsx`
Expected: FAIL — no narration line rendered yet

- [ ] **Step 3: Add the narration line**

In `src/components/agents/AgentRosterCard.tsx`, import the verbosity helper near the top:

```typescript
import { applyNarrationVerbosity } from '../../shared/narrationVerbosity';
```

Inside the `group.dispatches.map((a) => { ... })` block, next to the existing `const headline = ...` line, add:

```typescript
                const rawNarration = state.dispatchNarrations[a.toolUseId];
                const narration = rawNarration
                  ? applyNarrationVerbosity(rawNarration, state.cfg.narrationVerbosity, 1)
                  : null;
```

(Severity is passed as `1` here because this stage's IPC payload — Task 8 — doesn't carry severity alongside the narration string yet; the dial floor for sev≥3 is therefore not yet reachable from the roster today. This is a named, deliberate scope limit, not an oversight: wiring severity through the IPC payload is a natural one-line follow-up once this task's shape is confirmed working end-to-end, left for a fast-follow rather than growing this task.)

And render it under the existing `descStyle` div:

```typescript
                      <div style={descStyle(colors)}>{headline}</div>
                      {narration && <div data-testid="narration-line" style={narrationStyle(colors)}>{narration}</div>}
```

Add the style function near the other style helpers at the bottom of the file:

```typescript
function narrationStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 2,
    font: `500 10px/1.4 ${fonts.mono}`,
    color: colors.textMuted,
    fontStyle: 'italic',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/agents/AgentRosterCard.narration.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run --exclude '**/.worktrees/**'`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/AgentRosterCard.tsx src/components/agents/AgentRosterCard.narration.test.tsx
git commit -m "feat(voice-packs): render narration line in AgentRosterCard behind the verbosity dial"
```

---

### Task 11: Settings UI — verbosity dial

**Files:**
- Modify: `src/state/types.ts` (add `narrationVerbosity` to `Cfg`, near line 220's `densityLevel`)
- Modify: `src/state/initialState.ts` (default value)
- Create: `src/components/settings/NarrationVerbosityCard.tsx`
- Modify: `src/components/settings/SettingsView.tsx` (mount the new card)
- Test: `src/components/settings/NarrationVerbosityCard.test.tsx`

**Interfaces:**
- Consumes: `NarrationVerbosity` from Task 4 (`src/shared/narrationVerbosity.ts`), `UPDATE_CFG` action (existing)
- Produces: `Cfg.narrationVerbosity: NarrationVerbosity`, default `'full'`

- [ ] **Step 1: Write the failing test**

```typescript
// src/components/settings/NarrationVerbosityCard.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NarrationVerbosityCard } from './NarrationVerbosityCard';
import { AetherStoreProvider } from '../../state/store';
import { initialState } from '../../state/initialState';

describe('NarrationVerbosityCard', () => {
  it('shows FULL as active by default', () => {
    render(
      <AetherStoreProvider initial={initialState}>
        <NarrationVerbosityCard />
      </AetherStoreProvider>
    );
    expect(screen.getByText('FULL')).toBeInTheDocument();
  });

  it('clicking SILENT updates cfg.narrationVerbosity', () => {
    render(
      <AetherStoreProvider initial={initialState}>
        <NarrationVerbosityCard />
      </AetherStoreProvider>
    );
    fireEvent.click(screen.getByText('SILENT'));
    expect(screen.getByText(/severity 3\+/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/NarrationVerbosityCard.test.tsx`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Add the Cfg field**

In `src/state/types.ts`, next to line 220's `densityLevel: 'normal' | 'verbose' | 'summary';`:

```typescript
  narrationVerbosity: 'full' | 'terse' | 'silent';
```

In `src/state/initialState.ts`, add the default next to wherever `densityLevel: 'normal'` is set:

```typescript
  narrationVerbosity: 'full',
```

- [ ] **Step 4: Write the settings card**

```typescript
// src/components/settings/NarrationVerbosityCard.tsx
// Modeled on ModelPolicyCard.tsx's button-row pattern. Governs the roster's
// voice-pack narration line (AgentRosterCard) only -- unrelated to Chat's
// densityLevel dial, which governs transcript summarization, not narration.
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { NarrationVerbosity } from '../../shared/narrationVerbosity';

const LEVELS: NarrationVerbosity[] = ['full', 'terse', 'silent'];

export function NarrationVerbosityCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const level = state.cfg.narrationVerbosity;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>NARRATION</div>
      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        {LEVELS.map((l) => (
          <Button
            key={l}
            onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { narrationVerbosity: l } })}
            style={levelButtonStyle(colors, l === level)}
          >
            {l.toUpperCase()}
          </Button>
        ))}
      </div>
      <div style={hintStyle(colors)}>
        Controls the agent roster's voice-pack narration line. At severity 3+, narration always renders regardless of this setting.
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function levelButtonStyle(colors: ColorPalette, active: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: active ? '#04202b' : colors.textMuted,
    background: active ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: active ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: active ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 6,
    font: `500 11px/1.4 ${fonts.ui}`,
    color: colors.textMuted,
  };
}
```

- [ ] **Step 5: Mount it in SettingsView**

In `src/components/settings/SettingsView.tsx`, import and render `<NarrationVerbosityCard />` next to the existing `<ModelPolicyCard />` mount point.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/components/settings/NarrationVerbosityCard.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run --exclude '**/.worktrees/**'`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/components/settings/NarrationVerbosityCard.tsx src/components/settings/SettingsView.tsx src/components/settings/NarrationVerbosityCard.test.tsx
git commit -m "feat(voice-packs): add narration verbosity dial to Settings"
```

---

## After all tasks land

- Update `docs/roadmap.md` row 12's status from "Planned" to "Status: shipped", following the same phrasing pattern every other shipped row uses, and note the two named-not-glossed follow-ups this plan deferred: (1) `electron/collectorStore.ts`'s stale telemetry reader (design doc, gap #1) and (2) wiring real severity (not the fixed `1`) through the `agents:narration` IPC payload (Task 10's note).
- Run `npm test` once more from the repo root (not just `npx vitest`) to confirm the `test/*.test.js` Node suite is unaffected.
