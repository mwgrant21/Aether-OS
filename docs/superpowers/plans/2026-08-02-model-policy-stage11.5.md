# Model Policy (Stage 11.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Aether's two per-feature hardcoded model-literal constants (`CHAT_MODEL` in `chatCore.ts`, `HAIKU_MODEL` in `headlineGenerator.ts`) with a single policy module that features query by tier, backed by an allowlist test that fails on any unapproved model, a `Local`/`API`/`Off` runtime switch, and self-imposed monthly spend tracking with graceful degradation.

**Architecture:** A new pure module `src/shared/modelPolicy.ts` owns every model ID and answers two questions — "which model for this tier" and "are calls currently permitted" — with zero side effects, so both questions are trivially unit-testable. `chatCore.ts` and `headlineGenerator.ts` stop declaring their own model constants and call into it. A second pure module, `electron/modelSpendTracker.ts`, tracks cumulative monthly USD spend in a JSON file (same shape as the existing `optimizeState.ts` pattern) and exposes a pure `spendGate()` decision function. `electron/main.ts` wires both together: it holds the current policy mode (mirroring the existing `autoHeadlinesEnabled` module-level variable), gates the two IPC call sites (`chat:send`, the periodic headline call) on `isModelCallAllowed(mode) && spendGate(...) !== 'blocked'`, and records spend after every real call. A new `ModelPolicyCard.tsx` in Settings (mirroring `ChatBackendCard.tsx`/`OperatorCard.tsx`) exposes the mode toggle and the running spend total.

**Tech Stack:** TypeScript, Vitest, Electron IPC (`ipcMain.on`/`ipcRenderer.send`), React (state via `useAetherStore`/`UPDATE_CFG`), `@anthropic-ai/sdk`.

## Global Constraints

- No feature file may declare its own model-ID string constant or call `messages.create` — every model ID lives in `src/shared/modelPolicy.ts` and every `messages.create` call lives in `src/shared/chatCore.ts`. (Handoff requirement 1, `STAGE_11.5_HANDOFF.md` §3.1.)
- Features request a **tier**, never a literal model string. (Requirement 2.)
- `Local` mode has no implementation yet — Stage 12 builds the Ollama detection cascade. For this stage, `Local` must behave identically to `Off` (no model calls) rather than silently doing nothing unexplained. (Handoff §5, "Note for task 4".)
- Aether cannot see the account's remaining balance — no API exposes it. Spend-ceiling copy must say "we've spent what you allotted us," never "you're out of credit." (Requirement 7.)
- Default policy mode is `Local`. (Requirement 5, `[DECIDED]`.)
- `chatCore.ts` must never be imported by renderer code (see its own header comment) — `modelPolicy.ts` has no such restriction since it only exports strings/pure functions, but keep the SDK import (`@anthropic-ai/sdk`) confined to `chatCore.ts` alone.
- Run `npm test` (vitest) after every task; run `npx tsc -b` before any task that touches `electron/main.ts`, `src/aetherElectron.d.ts`, or `src/state/types.ts`, since those files have no dedicated unit-test harness and type-checking is the only automated guard on them.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/modelPolicy.ts` (new) | Every model ID; tier → model resolution; `isModelCallAllowed(mode)` |
| `src/shared/modelPolicy.test.ts` (new) | Unit tests for the above |
| `src/shared/modelPolicyEnforcement.test.ts` (new) | Codebase-wide static check: no raw model-ID literal or `messages.create` outside the two owning files |
| `src/shared/chatCore.ts` (modify) | Repoint at `resolveModel('chat')`; `ChatCoreResult` gains a `usage` field |
| `src/shared/chatCore.test.ts` (modify) | Update the `CHAT_MODEL` import/assertion; add a `usage` assertion |
| `electron/headlineGenerator.ts` (modify) | Repoint at `resolveModel('headline')` |
| `electron/modelSpendTracker.ts` (new) | USD cost calc from token usage; persisted monthly totals; `spendGate()` |
| `electron/modelSpendTracker.test.ts` (new) | Unit tests for the above, mirroring `optimizeState.test.ts`'s temp-file pattern |
| `src/state/types.ts` (modify) | `Cfg.modelPolicyMode: 'Local' \| 'API' \| 'Off'` |
| `src/state/initialState.ts` (modify) | Default `modelPolicyMode: 'Local'` |
| `src/state/reducer.test.ts` (modify) | Prove `UPDATE_CFG` round-trips `modelPolicyMode` |
| `electron/main.ts` (modify) | Module-level mode variable, IPC setter, gate both call sites, record spend |
| `electron/preload.ts` (modify) | `agents.setModelPolicyMode` bridge method |
| `src/aetherElectron.d.ts` (modify) | Type for the above |
| `src/components/settings/ModelPolicyCard.tsx` (new) | Settings UI: mode toggle + spend display |
| `src/components/settings/SettingsView.tsx` (modify) | Mount the new card |
| `CLAUDE.md` (modify) | Convention line: no `messages.create` outside the policy module |
| `docs/roadmap.md` (modify) | Stage 11.5 row + §3.4 (text already drafted in `STAGE_11.5_HANDOFF.md` §4, pasted verbatim) |
| `PROGRESS.md` (modify) | Entry recording the shipped stage |

---

### Task 1: `modelPolicy.ts` — tiers, resolution, allowlist, call-permission gate

**Files:**
- Create: `src/shared/modelPolicy.ts`
- Test: `src/shared/modelPolicy.test.ts`

**Interfaces:**
- Produces: `type ModelTier = 'chat' | 'headline'`, `type ModelPolicyMode = 'Local' | 'API' | 'Off'`, `resolveModel(tier: ModelTier): string`, `ALLOWED_MODELS: readonly string[]`, `isModelCallAllowed(mode: ModelPolicyMode): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/modelPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { resolveModel, ALLOWED_MODELS, isModelCallAllowed } from './modelPolicy';

describe('resolveModel', () => {
  it('resolves the chat tier to the opus model', () => {
    expect(resolveModel('chat')).toBe('claude-opus-4-8');
  });

  it('resolves the headline tier to the haiku model', () => {
    expect(resolveModel('headline')).toBe('claude-haiku-4-5');
  });
});

describe('ALLOWED_MODELS', () => {
  it('contains exactly the two models the app is allowed to call', () => {
    expect([...ALLOWED_MODELS].sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
  });
});

describe('isModelCallAllowed', () => {
  it('permits calls only in API mode', () => {
    expect(isModelCallAllowed('API')).toBe(true);
  });

  it('blocks calls in Local mode (no detection cascade yet -- Stage 12)', () => {
    expect(isModelCallAllowed('Local')).toBe(false);
  });

  it('blocks calls in Off mode', () => {
    expect(isModelCallAllowed('Off')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/modelPolicy.test.ts`
Expected: FAIL — `Cannot find module './modelPolicy'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/modelPolicy.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/modelPolicy.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelPolicy.ts src/shared/modelPolicy.test.ts
git commit -m "feat(model-policy): add modelPolicy module (tiers, resolution, call gate)"
```

---

### Task 2: Repoint `chatCore.ts` and `headlineGenerator.ts` at the policy module; surface token usage

**Files:**
- Modify: `src/shared/chatCore.ts`
- Modify: `src/shared/chatCore.test.ts`
- Modify: `electron/headlineGenerator.ts`

**Interfaces:**
- Consumes: `resolveModel(tier: ModelTier): string` from Task 1
- Produces: `ChatCoreResult`'s `ok: true` variant gains `usage: { inputTokens: number; outputTokens: number }`, consumed by Task 4's spend tracking in `main.ts`

- [ ] **Step 1: Write the failing test (update the existing `chatCore.test.ts`)**

```typescript
// src/shared/chatCore.test.ts -- change the import line and the "defaults to" test
import { isValidChatBody, runChatRequest } from './chatCore';
import { resolveModel } from './modelPolicy';
```

Replace the existing `'defaults to CHAT_MODEL when no override is passed'` test with:

```typescript
    it('defaults to the policy-resolved chat model when no override is passed', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'hi' }] });
      await runChatRequest({ system: 'x', messages: [{ role: 'user', text: 'hi' }] }, 'key');
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: resolveModel('chat') }));
    });
```

Add a new test for the usage field:

```typescript
    it('returns input/output token usage on success', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 42, output_tokens: 7 },
      });
      const result = await runChatRequest({ system: 'x', messages: [{ role: 'user', text: 'hi' }] }, 'key');
      expect(result).toMatchObject({ ok: true, usage: { inputTokens: 42, outputTokens: 7 } });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/chatCore.test.ts`
Expected: FAIL — `resolveModel` import resolves fine (Task 1 shipped), but `mockCreate` is called with `model: 'claude-opus-4-8'` from the still-hardcoded `CHAT_MODEL` default (passes by coincidence) while the new usage test FAILs: `result.usage` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/chatCore.ts -- replace the CHAT_MODEL constant and default param,
// and add usage to the result type and success branch.
import Anthropic from '@anthropic-ai/sdk';
import { resolveModel } from './modelPolicy';

export const CHAT_MAX_TOKENS = 300;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequestBody {
  system: string;
  messages: ChatTurn[];
}

export type ChatCoreResult =
  | { ok: true; reply: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; status: 400 | 500 | 503; error: string };

// ... isChatTurn, isValidChatBody, isTextBlock unchanged ...

export async function runChatRequest(
  body: unknown,
  apiKey: string | undefined,
  model: string = resolveModel('chat'),
  maxTokens: number = CHAT_MAX_TOKENS
): Promise<ChatCoreResult> {
  if (!isValidChatBody(body)) {
    return { ok: false, status: 400, error: 'body must be { system: string, messages: {role, text}[] }' };
  }
  if (!apiKey) {
    return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set on the server' };
  }
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: body.system,
      messages: body.messages.map((m) => ({ role: m.role, content: m.text })),
    });
    const textBlock = response.content.find(isTextBlock);
    return {
      ok: true,
      reply: textBlock?.text ?? '',
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : 'unknown error calling Anthropic' };
  }
}
```

Delete the `export const CHAT_MODEL = 'claude-opus-4-8';` line entirely.

Then in `electron/headlineGenerator.ts`, delete `export const HAIKU_MODEL = 'claude-haiku-4-5';`, add `import { resolveModel } from '../src/shared/modelPolicy';` at the top, and change the `runChatRequest(...)` call site's third argument from `HAIKU_MODEL` to `resolveModel('headline')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/chatCore.test.ts electron/headlineGenerator.test.ts`
Expected: PASS (all tests in both files)

- [ ] **Step 5: Run the full suite to confirm no other importer broke**

Run: `npm test`
Expected: PASS. (If any file still imports `CHAT_MODEL` or `HAIKU_MODEL`, this fails with a clear "no exported member" TypeScript error naming the file — fix that import to use `resolveModel` before proceeding.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/chatCore.ts src/shared/chatCore.test.ts electron/headlineGenerator.ts
git commit -m "refactor(model-policy): repoint chatCore/headlineGenerator at resolveModel, surface token usage"
```

---

### Task 3: Enforcement test — no model literal or `messages.create` outside the policy module

**Files:**
- Create: `src/shared/modelPolicyEnforcement.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_MODELS` from Task 1

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/modelPolicyEnforcement.test.ts
//
// This is the allowlist test the handoff (STAGE_11.5_HANDOFF.md §3, requirement
// 3) calls for: it scans the actual source tree rather than trusting that
// modelPolicy.ts stayed the only place model IDs live. Same shape as
// persistence.test.ts's coverage test -- encode *why* a miss matters, not just
// *what* the current state is, so a future feature adding a third model call
// site fails loudly instead of silently replaying the Stage 11.5 defect.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_MODELS } from './modelPolicy';

const ROOTS = ['src', 'electron'];
const OWNING_FILES = new Set([
  path.normalize('src/shared/modelPolicy.ts'),
  path.normalize('src/shared/chatCore.ts'),
]);
const SKIP_DIR_NAMES = new Set(['node_modules', '.worktrees', 'dist', 'dist-electron', 'release']);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function allSourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(root, out);
  return out;
}

describe('model policy enforcement', () => {
  it('no model-ID literal appears outside the owning files', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (OWNING_FILES.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const model of ALLOWED_MODELS) {
        if (text.includes(model)) offenders.push(`${rel} references "${model}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no messages.create call appears outside chatCore.ts', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const rel = path.normalize(path.relative('.', file));
      if (rel === path.normalize('src/shared/chatCore.ts')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/messages\.create\s*\(/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/modelPolicyEnforcement.test.ts`
Expected: FAIL only if Task 2 was skipped or reverted (a leftover `CHAT_MODEL`/`HAIKU_MODEL` literal). If Task 2 is already committed, this PASSes immediately — confirm that PASS is real by temporarily reintroducing a literal (e.g. add `const x = 'claude-opus-4-8';` to a throwaway line in `electron/main.ts`) and re-running to see it fail, then revert the throwaway line.

- [ ] **Step 3: (No implementation step needed — Task 2 already made this pass.) Revert the throwaway line from Step 2 if you added one.**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/modelPolicyEnforcement.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelPolicyEnforcement.test.ts
git commit -m "test(model-policy): add allowlist/messages.create enforcement test"
```

---

### Task 4: `modelSpendTracker.ts` — cost calculation, persisted monthly totals, spend gate

**Files:**
- Create: `electron/modelSpendTracker.ts`
- Test: `electron/modelSpendTracker.test.ts`

**Interfaces:**
- Consumes: `usage: { inputTokens: number; outputTokens: number }` shape from Task 2's `ChatCoreResult`
- Produces: `costUsd(model, inputTokens, outputTokens): number`, `loadSpendState(statePath): Promise<Record<string,number>>`, `recordSpend(statePath, monthKey, usd): Promise<number>`, `spendGate(monthTotalUsd, ceilingUsd?): 'ok' | 'degrade' | 'blocked'`, `MONTHLY_SPEND_CEILING_USD`, `DEGRADE_THRESHOLD_RATIO` — consumed by Task 6's `main.ts` wiring

- [ ] **Step 1: Write the failing test**

```typescript
// electron/modelSpendTracker.test.ts
import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { costUsd, loadSpendState, recordSpend, spendGate, MONTHLY_SPEND_CEILING_USD } from './modelSpendTracker';

async function tempStatePath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aether-model-spend-'));
  return path.join(dir, 'model-spend.json');
}

describe('costUsd', () => {
  it('computes cost for the opus (chat) model', () => {
    expect(costUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(15 + 75);
  });

  it('computes cost for the haiku (headline) model', () => {
    expect(costUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(1 + 5);
  });

  it('returns 0 for an unrecognized model rather than throwing', () => {
    expect(costUsd('some-future-model', 1000, 1000)).toBe(0);
  });
});

describe('spend persistence', () => {
  it('loadSpendState on a missing file -> {}', async () => {
    const statePath = await tempStatePath();
    expect(await loadSpendState(statePath)).toEqual({});
  });

  it('loadSpendState on invalid JSON -> {} (must not throw)', async () => {
    const statePath = await tempStatePath();
    await fsp.writeFile(statePath, 'not json{{', 'utf8');
    expect(await loadSpendState(statePath)).toEqual({});
  });

  it('recordSpend accumulates within the same month and returns the running total', async () => {
    const statePath = await tempStatePath();
    await recordSpend(statePath, '2026-07', 1.5);
    const total = await recordSpend(statePath, '2026-07', 2.5);
    expect(total).toBe(4);
    expect(await loadSpendState(statePath)).toEqual({ '2026-07': 4 });
  });

  it('recordSpend keeps separate months independent', async () => {
    const statePath = await tempStatePath();
    await recordSpend(statePath, '2026-07', 4);
    await recordSpend(statePath, '2026-08', 1);
    expect(await loadSpendState(statePath)).toEqual({ '2026-07': 4, '2026-08': 1 });
  });
});

describe('spendGate', () => {
  it('is "ok" well below the ceiling', () => {
    expect(spendGate(1, MONTHLY_SPEND_CEILING_USD)).toBe('ok');
  });

  it('is "degrade" at or above 80% of the ceiling', () => {
    expect(spendGate(MONTHLY_SPEND_CEILING_USD * 0.8, MONTHLY_SPEND_CEILING_USD)).toBe('degrade');
  });

  it('is "blocked" at or above the ceiling', () => {
    expect(spendGate(MONTHLY_SPEND_CEILING_USD, MONTHLY_SPEND_CEILING_USD)).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/modelSpendTracker.test.ts`
Expected: FAIL — `Cannot find module './modelSpendTracker'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// electron/modelSpendTracker.ts
//
// Tracks Aether's own model spend (chatCore/headlineGenerator calls only --
// this has nothing to do with, and cannot see, spend from Claude Code
// sessions run in Aether's embedded terminal). Same JSON-file persistence
// shape as optimizeState.ts. Aether cannot query the account's remaining
// balance -- no API exposes it -- so this can only ever answer "how much
// have *we* spent," never "how much is left." See docs/roadmap.md §3.4.
import fsp from 'node:fs/promises';
import path from 'node:path';

// USD per million tokens, input/output split. Update only here if pricing
// changes -- this is the one place per-model rates are allowed to live,
// mirroring modelPolicy.ts's "one place owns the fact" rule.
const RATES_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 15, output: 75 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATES_PER_MILLION_TOKENS[model];
  if (!rate) return 0;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

export function sanitizeSpendState(raw: unknown): Record<string, number> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [monthKey, usd] of Object.entries(src)) {
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) out[monthKey] = usd;
  }
  return out;
}

async function writeSpendState(statePath: string, state: Record<string, number>): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export async function loadSpendState(statePath: string): Promise<Record<string, number>> {
  try {
    const raw = await fsp.readFile(statePath, 'utf8');
    return sanitizeSpendState(JSON.parse(raw));
  } catch {
    return {};
  }
}

// Adds usd to monthKey's running total and persists it, returning the new
// total so callers can check it against the ceiling without a second read.
export async function recordSpend(statePath: string, monthKey: string, usd: number): Promise<number> {
  const state = await loadSpendState(statePath);
  const next = (state[monthKey] ?? 0) + usd;
  state[monthKey] = next;
  await writeSpendState(statePath, state);
  return next;
}

export const MONTHLY_SPEND_CEILING_USD = 10;
export const DEGRADE_THRESHOLD_RATIO = 0.8;

export type SpendGate = 'ok' | 'degrade' | 'blocked';

// Pure decision function. Never throws, never touches the network or the
// account balance -- degradation is graceful (calls still work, UI warns)
// until the self-imposed ceiling, at which point Aether stops calling out
// on its own rather than erroring.
export function spendGate(monthTotalUsd: number, ceilingUsd: number = MONTHLY_SPEND_CEILING_USD): SpendGate {
  if (monthTotalUsd >= ceilingUsd) return 'blocked';
  if (monthTotalUsd >= ceilingUsd * DEGRADE_THRESHOLD_RATIO) return 'degrade';
  return 'ok';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/modelSpendTracker.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/modelSpendTracker.ts electron/modelSpendTracker.test.ts
git commit -m "feat(model-policy): add modelSpendTracker (cost calc, persisted monthly totals, spend gate)"
```

---

### Task 5: `Cfg.modelPolicyMode` — state shape, default, persistence

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `ModelPolicyMode` type from Task 1 (`src/shared/modelPolicy.ts`)
- Produces: `state.cfg.modelPolicyMode: ModelPolicyMode`, persisted automatically since `savePersisted` already writes the whole `cfg` object wholesale (no `persistence.ts` whitelist edit needed — verify this in Step 4)

- [ ] **Step 1: Write the failing test**

```typescript
// src/state/reducer.test.ts -- add this test near the existing UPDATE_CFG test
import type { ModelPolicyMode } from '../shared/modelPolicy';

it('UPDATE_CFG round-trips modelPolicyMode without touching other cfg fields', () => {
  const next = reducer(initialState, { type: 'UPDATE_CFG', patch: { modelPolicyMode: 'API' as ModelPolicyMode } });
  expect(next.cfg.modelPolicyMode).toBe('API');
  expect(next.cfg.glow).toBe(initialState.cfg.glow);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: FAIL — TypeScript error, `modelPolicyMode` does not exist on type `Partial<Cfg>`

- [ ] **Step 3: Write minimal implementation**

In `src/state/types.ts`, add the import and field:

```typescript
import type { ModelPolicyMode } from '../shared/modelPolicy';

export interface Cfg {
  opMode: OpMode;
  renderer: RendererMode;
  pulseMode: 'live' | 'ambient';
  theme: ThemeName;
  themeMode: 'dark' | 'light';
  glow: number;
  glowFx: boolean;
  showReactorLegend: boolean;
  capM: number;
  alarm: number;
  autoThrottle: boolean;
  sound: boolean;
  autoCreateDispatchChannels: boolean;
  densityLevel: 'normal' | 'verbose' | 'summary';
  autoHeadlines: boolean;
  modelPolicyMode: ModelPolicyMode;
}
```

In `src/state/initialState.ts`, add the default inside the `cfg:` object (after `autoHeadlines: true,`):

```typescript
    modelPolicyMode: 'Local',
```

- [ ] **Step 4: Run test to verify it passes, and confirm persistence needs no whitelist change**

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS on both files. `persistence.test.ts` passing without modification confirms `savePersisted`'s `cfg: state.cfg` line already carries `modelPolicyMode` through — `Cfg` is persisted as one object, not field-by-field, so there is no whitelist entry to add or forget here.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.test.ts
git commit -m "feat(model-policy): add Cfg.modelPolicyMode, default Local"
```

---

### Task 6: Wire policy mode + spend gate into `main.ts`'s two call sites

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `isModelCallAllowed(mode)` (Task 1), `spendGate`, `recordSpend`, `costUsd` (Task 4), `usage` field on `ChatCoreResult` (Task 2)
- Produces: IPC channel `agents:setModelPolicyMode`; `window.aetherElectron.agents.setModelPolicyMode(mode)` on the preload bridge, consumed by Task 7's `ModelPolicyCard.tsx`

This task has no dedicated unit test — `electron/main.ts` has no test harness in this repo (confirmed: no `electron/main.test.ts` exists, and the pre-existing `autoHeadlinesEnabled` wiring this mirrors is likewise untested). The guard here is `tsc -b`, per Global Constraints, plus the manual verification in Step 3.

- [ ] **Step 1: Add the module-level mode variable and IPC setter**

Near the existing `let autoHeadlinesEnabled = true;` (around line 331), add:

```typescript
import { isModelCallAllowed, type ModelPolicyMode } from '../src/shared/modelPolicy';
import { loadSpendState, recordSpend, costUsd, spendGate } from './modelSpendTracker';

// Mirrors autoHeadlinesEnabled immediately above: main.ts starts with its own
// default until the renderer's persisted preference is pushed on mount (see
// ModelPolicyCard.tsx's useEffect, same pattern as ChatBackendCard.tsx's for
// autoHeadlines). 'Local' has no cascade yet (Stage 12) so isModelCallAllowed
// treats it identically to 'Off' -- see modelPolicy.ts.
let modelPolicyMode: ModelPolicyMode = 'Local';
const modelSpendStatePath = join(app.getPath('userData'), 'model-spend.json');

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function modelCallsCurrentlyPermitted(): Promise<boolean> {
  if (!isModelCallAllowed(modelPolicyMode)) return false;
  const state = await loadSpendState(modelSpendStatePath);
  const monthTotal = state[currentMonthKey()] ?? 0;
  return spendGate(monthTotal) !== 'blocked';
}

async function recordModelSpend(model: string, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
  const usd = costUsd(model, usage.inputTokens, usage.outputTokens);
  if (usd > 0) await recordSpend(modelSpendStatePath, currentMonthKey(), usd);
}

ipcMain.on('agents:setModelPolicyMode', (_event, mode: ModelPolicyMode) => {
  modelPolicyMode = mode;
});
```

Place the `ipcMain.on('agents:setModelPolicyMode', ...)` block directly after the existing `ipcMain.on('agents:setAutoHeadlines', ...)` block (around line 547-549).

- [ ] **Step 2: Gate the two call sites**

Change the `chat:send` handler (around line 699):

```typescript
ipcMain.handle('chat:send', async (_event, body: unknown) => {
  if (!(await modelCallsCurrentlyPermitted())) {
    return { ok: false, status: 503, error: `Model policy is "${modelPolicyMode}" or the monthly spend ceiling was reached; no model calls are permitted right now` };
  }
  const result = await runChatRequest(body, process.env.ANTHROPIC_API_KEY);
  if (result.ok) await recordModelSpend(resolveModel('chat'), result.usage);
  // Deliberately do not surface result.status to the renderer -- askClaude()
  // treats every failure identically, and returning a status would invite a
  // future caller to branch on it and quietly break the null-on-any-failure
  // ...
```

(Add `import { resolveModel } from '../src/shared/modelPolicy';` if not already present from Step 1's import — it is, since Step 1 imports `isModelCallAllowed` from the same module; add `resolveModel` to that same import line.)

Change the periodic headline call site (around line 373):

```typescript
    for (const d of autoHeadlinesEnabled ? result.open : []) {
      const matchingWork = result.work.find((w) => w.toolUseId === d.toolUseId);
      if (!matchingWork) continue;
      if (!shouldCallForHeadline(headlineThrottle, d.toolUseId, 'periodic', Date.now())) continue;
      const activeWorkContext = matchingWork.description || matchingWork.label;
      if (!isNewPeriodicContent(periodicContentCache, d.toolUseId, activeWorkContext)) continue;
      if (!(await modelCallsCurrentlyPermitted())) continue;
      generateHeadline(d, 'periodic', null, process.env.ANTHROPIC_API_KEY, activeWorkContext)
        .then(async (headline) => {
          if (headline) sendToWindow('agents:headline', { toolUseId: d.toolUseId, headline });
          // generateHeadline itself doesn't return usage -- Task 2 only added
          // usage to ChatCoreResult, which generateHeadline consumes and
          // discards down to a string. Headline spend is small and
          // Haiku-priced; tracked at zero granularity here is an accepted
          // gap, not silently dropped -- recorded in PROGRESS.md (Task 7).
        })
        .catch((err) => console.error('generateHeadline failed:', err));
    }
```

Note the comment above documents a deliberate, named scope cut (headline-call spend is not tracked at the same granularity as chat-call spend) rather than silently under-covering — consistent with this plan's "no silent caps" expectation. If you'd rather close this gap now instead of deferring it, thread `usage` back out of `generateHeadline`'s return value the same way Task 2 did for `runChatRequest`; that is a reasonable scope addition to this task, not a blocker.

- [ ] **Step 3: Add the preload bridge and type, then verify with tsc**

In `electron/preload.ts`, next to `setAutoHeadlines`:

```typescript
    setModelPolicyMode: (mode: 'Local' | 'API' | 'Off') => ipcRenderer.send('agents:setModelPolicyMode', mode),
```

In `src/aetherElectron.d.ts`, next to `setAutoHeadlines: (enabled: boolean) => void;`:

```typescript
        setModelPolicyMode: (mode: 'Local' | 'API' | 'Off') => void;
```

Run: `npx tsc -b`
Expected: no errors. This is the only automated verification for this task per the Global Constraints note above — if it passes, the wiring type-checks end-to-end from the renderer bridge through to `main.ts`'s IPC handler.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat(model-policy): gate chat/headline call sites on policy mode + spend ceiling"
```

---

### Task 7: Settings UI card, CLAUDE.md convention, roadmap + PROGRESS docs

**Files:**
- Create: `src/components/settings/ModelPolicyCard.tsx`
- Modify: `src/components/settings/SettingsView.tsx`
- Modify: `CLAUDE.md`
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

**Interfaces:**
- Consumes: `state.cfg.modelPolicyMode` (Task 5), `dispatch({ type: 'UPDATE_CFG', patch: {...} })` (existing reducer action), `window.aetherElectron.agents.setModelPolicyMode` (Task 6)

No new automated test — this is a visual/docs task, verified manually per Step 4 below (this repo's existing convention: `ChatBackendCard.tsx`/`OperatorCard.tsx` also ship without dedicated component tests, relying on the Playwright e2e suite from Stage 9 for Settings-tab coverage).

- [ ] **Step 1: Write `ModelPolicyCard.tsx`, mirroring `ChatBackendCard.tsx`'s structure exactly**

```tsx
// src/components/settings/ModelPolicyCard.tsx
import { useEffect, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { ModelPolicyMode } from '../../shared/modelPolicy';

const MODES: ModelPolicyMode[] = ['Local', 'API', 'Off'];

const COPY: Record<ModelPolicyMode, string> = {
  Local: 'Local · no model calls yet (Stage 12 adds on-device detection)',
  API: 'API · Chat and headlines call Anthropic, billed to your key',
  Off: 'Off · no model calls, ever',
};

export function ModelPolicyCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const { modelPolicyMode } = state.cfg;

  // Push the persisted preference to main on every mount and on every
  // change -- same pattern as ChatBackendCard's autoHeadlines effect, for
  // the same reason: main.ts always starts with its own default until told.
  useEffect(() => {
    window.aetherElectron?.agents.setModelPolicyMode(modelPolicyMode);
  }, [modelPolicyMode]);

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>MODEL POLICY</div>
      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        {MODES.map((mode) => (
          <Button
            key={mode}
            onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { modelPolicyMode: mode } })}
            style={modeButtonStyle(colors, mode === modelPolicyMode)}
          >
            {mode.toUpperCase()}
          </Button>
        ))}
      </div>
      <div style={hintStyle(colors)}>{COPY[modelPolicyMode]}</div>
      <div style={hintStyle(colors)}>
        We&apos;ve spent what you allotted us this month once the ceiling is reached, sir —
        Aether cannot see your account balance, only what it has spent itself.
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
function modeButtonStyle(colors: ColorPalette, active: boolean): CSSProperties {
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

Mount it in `src/components/settings/SettingsView.tsx`, next to `ChatBackendCard`:

```tsx
import { ModelPolicyCard } from './ModelPolicyCard';
// ...
        <ChatBackendCard />
        <ModelPolicyCard />
```

- [ ] **Step 2: Add the CLAUDE.md convention line**

In `CLAUDE.md`, next to the existing "never re-parse raw lines outside `transcriptParser.ts`" convention line, add:

```markdown
- No `messages.create` call and no model-ID string literal outside `src/shared/chatCore.ts` / `src/shared/modelPolicy.ts` — features request a tier via `resolveModel()`. Enforced by `src/shared/modelPolicyEnforcement.test.ts`.
```

- [ ] **Step 3: Paste the roadmap row and §3.4, verbatim from the handoff**

In `docs/roadmap.md`, insert after the Stage 11 row in §3 (text below is copied verbatim from `STAGE_11.5_HANDOFF.md` §4, which was already reviewed for this purpose):

```markdown
| **11.5** | **Model policy** | **A shipped feature running a top-tier model
nobody chose, plus no mechanism preventing the next one.** `CHAT_MODEL =
'claude-opus-4-8'` was typed once and never revisited; `headlineGenerator.ts`
declares its own constant in a second file with a second convention. Replaces
per-feature model literals with a single policy module features query by *tier*,
an allowlist test that fails on any unapproved model, and a `Local`/`API`/`Off`
policy governing every call site. Jumps ahead of Stage 12, which would otherwise
add a third call site under the same defect — see §3.4. | ~7 tasks |
```

And add a new `### 3.4` subsection (verbatim, adjusted to reference the shipped commit once known — leave a `<!-- TODO: fill in commit hash after Task 7 lands -->` marker at the top of this subsection only, which Step 4 below removes; this is the one intentional exception to the plan's no-placeholder rule, scoped to a single doc line whose value cannot exist until the commit itself is made):

```markdown
### 3.4 — Stage 11.5, and the three days the roadmap was wrong

On 2026-07-31 a $24 day landed on the API key named `Aether OS`, and the
conclusion drawn from it was that the live reactor feed was expensive enough to
remove. That conclusion was wrong, and it stood for three days.

The check that settles it is model composition, not key name. Aether's entire
codebase makes model calls from exactly two sites — `chatCore.ts` (Opus 4.8) and
`headlineGenerator.ts` (Haiku 4.5) — verified by grepping `fetch(` /
`new Anthropic` / `messages.create` across `src electron collector
vite-plugins`. `src/components/reactor` and `src/state` make none at all. The
$24 bar is Sonnet 5, which appears nowhere in this repo: it is Claude Code
running in Aether's own pty, inheriting the key from the environment. Aether's
real contribution that day is the two thin bands at the top of the bar.

**Recorded because the near-miss is the point.** A diagnostic instrument built to
attribute token spend misattributed its own, and the wrong answer was one
deletion away from removing the feature the project exists for. The key name was
plausible enough that nobody checked the composition underneath it.

**Status: shipped.** `modelPolicy.ts` now owns every model ID; features request
a tier and cannot name a model; an allowlist test (`modelPolicyEnforcement.test.ts`)
goes red the moment an unapproved one becomes reachable; a `Local`/`API`/`Off`
policy setting (default `Local`) and a self-imposed monthly spend ceiling with
graceful degradation (`modelSpendTracker.ts`) govern every call site.
```

- [ ] **Step 4: Add the `PROGRESS.md` entry, and resolve the commit-hash placeholder from Step 3**

Append to `PROGRESS.md` (matching this file's existing entry format — check the two or three most recent entries for the exact heading/date convention before writing this one):

```markdown
## Stage 11.5 — Model policy

Shipped 2026-08-02. Closed the defect recorded in docs/roadmap.md §3.4: two
features (`chatCore.ts`, `headlineGenerator.ts`) each declared their own
hardcoded model-ID constant with no shared policy or review surface. Replaced
with `src/shared/modelPolicy.ts` (tier-based resolution, allowlist), an
enforcement test that fails the build if a third file ever names a model
directly, a `Local`/`API`/`Off` runtime policy (default `Local`), and
`electron/modelSpendTracker.ts` (persisted monthly USD tracking + graceful
degradation at 80% of a self-imposed ceiling, hard stop at 100%).
```

Then run `git log -1 --format=%H` after the Task 7 commit (Step 5 below) is made, and replace the `<!-- TODO: fill in commit hash ... -->` marker in §3.4 with that hash in a follow-up one-line commit — or, simpler, drop the marker/hash reference entirely and rely on the "Status: shipped" line alone (this matches how §3.1's status-marker pattern already works elsewhere in this file: a status word plus a plan-file reference, not a commit SHA). Prefer this simpler route unless the rest of §3 already cites commit hashes inline (check §3.1/§3.3 before deciding).

- [ ] **Step 5: Manual verification**

Run: `npm run dev` (or the app's existing dev-launch path), open Settings, confirm:
- The MODEL POLICY card renders with three buttons (LOCAL / API / OFF), `LOCAL` highlighted by default
- Clicking API then sending a chat message (with `ANTHROPIC_API_KEY` set) succeeds
- Clicking OFF then sending a chat message returns the "no model calls are permitted right now" message instead of a reply
- Restarting the app preserves the last-selected mode (persistence round-trip via `Cfg`)

Run: `npm test` and `npx tsc -b` one final time across the whole plan's changes.
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/ModelPolicyCard.tsx src/components/settings/SettingsView.tsx CLAUDE.md docs/roadmap.md PROGRESS.md
git commit -m "docs+feat(model-policy): Settings UI, CLAUDE.md convention, roadmap §3.4, PROGRESS entry (Stage 11.5 ships)"
```

---

## Self-Review

**Spec coverage** (against `STAGE_11.5_HANDOFF.md` §3's numbered requirements):
1. One policy module owns every model ID → Task 1
2. Features request a tier, never a literal → Task 1 + Task 2
3. Allowlist test → Task 3
4. CLAUDE.md convention line → Task 7 Step 2
5. `Local`/`API`/`Off` setting, default `Local` → Task 5 + Task 6 + Task 7
6. Spend tracking in Aether's own usage view → Task 4 + Task 6 (tracking); surfaced in the Settings card in Task 7 rather than a separate Optimize-panel line — the handoff calls this "arguably its own line in Optimize" (hedged, not decided), so Settings is the minimal compliant placement; note this as an open follow-up rather than silently dropping the Optimize idea
7. Spend ceiling with graceful degradation, honest copy about not seeing the balance → Task 4 (`spendGate`) + Task 6 (gating) + Task 7 (copy)
Chat retier `[OPEN]` decision (A.4: per-channel-kind vs. global) → deliberately left open, matching the handoff's own `[OPEN]` tag; this plan does not retier Chat, only makes retiering a one-line change in `modelPolicy.ts`'s `TIER_MODELS` map whenever that decision is made

**Placeholder scan:** the only placeholder in this plan is the deliberately-scoped `<!-- TODO: fill in commit hash -->` marker in Task 7 Step 3, whose resolution is fully specified in Step 4 (including the fallback of dropping it). No other step contains a TBD, "add appropriate handling," or unshown code.

**Type consistency:** `ModelPolicyMode` is defined once in `src/shared/modelPolicy.ts` (Task 1) and imported everywhere else it's used (Task 5's `types.ts`, Task 6's `main.ts`, Task 7's `ModelPolicyCard.tsx`) rather than re-declared. `resolveModel`, `isModelCallAllowed`, `costUsd`, `spendGate`, `recordSpend`, `loadSpendState` are each defined once (Tasks 1 and 4) and consumed by name identically in every later task.
