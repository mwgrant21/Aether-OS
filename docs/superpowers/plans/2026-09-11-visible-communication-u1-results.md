# Visible communication U1 checkpoint

U1 contracts and pure lifecycle transitions are implemented. The application does not yet expose the bridge or invoke a provider through this unit.

Branch: `feat/visible-communication-u1`.
Base: `28b7fc4`, after fast-forwarding master from `7074014`.
Worktree: `C:/Users/Matt/projects/aether-os/.worktrees/visible-communication-u1`.
Approved design: `2026-09-11-visible-agent-communication-v4.md` in this directory.

## Implemented

- `src/shared/communicationTypes.ts`: separate content and metadata contracts, immutable identities, limits, versioned status/error/page types, and main-only launch bookkeeping.
- `src/shared/communicationLifecycle.ts`: immutable admission, input byte validation, reservations, submission accounting, explicit refunds, grants, deduplication, cooldowns, leases/deadlines, provider outcomes, cleanup status, content expiry, and unique-page accounting.
- `src/shared/communicationLifecycle.test.ts`: 35 focused cases. Lost acknowledgments and accepted aliases recover existing exchanges; aliases are bounded; expiry retains deduplication records; success clears cooldown; failed/uncertain submissions cannot be silently refunded; page replay cannot inflate delivery; observed zero differs from unavailable data.

Cleanup state is separate from provider outcome. A cleanup failure stays visible and retains the active slot without rewriting a completed answer. Successful completion establishes consumed credit even when the initial submission acknowledgment was uncertain. Observed output, including an oversized first chunk, prevents a contradictory non-submission refund.

## Verification

| Check | Verdict | Result |
| --- | --- | --- |
| Focused lifecycle suite | **Passed** | 35/35, run by implementer and independent reviewer |
| Independent review | **Passed** | No blocking findings after refund/cleanup/status and alias-cap corrections |
| Full root suite | **Passed** | 1,532 passed; 6 skipped, across 140 passing files and 1 skipped file |
| Electron TypeScript | **Passed** | `npm run typecheck:electron` |
| Renderer build | **Passed** | `npm run build` |
| Electron build | **Passed** | `npm run electron:build` |

Build output includes warnings about the existing optimizeRules node:path import and bundle size. No packaging, Electron UI launch, Playwright, collector suite, or live provider test was run for this pure shared-logic unit. Those are outside this checkpoint; skipped tests are not claimed as passed. Dependencies are installed in this worktree, not linked to another checkout.

## Claude U1 review disposition

Claude independently reproduced the original gates and accepted U1, then committed `928567f` to bound request-key aliases at 32 per exchange. The bound is retained. The follow-up rejects new aliases at capacity with `ALIAS_LIMIT`, rather than returning a successful response for a key that was not retained. Silent success would break get-by-key recovery if the acknowledgment were lost. Every successful alias remains resolvable; overflow retains no new key and reserves no credit. Existing keys recover even during cooldown or credit exhaustion, and still enforce KEY_CONFLICT. The new rejection uses the normal ask cooldown and is recorded in the v4 error contract.

INVALID_INPUT intentionally triggers the anti-rephrasing cooldown, including human-requested follow-ups in the same launch. Launch/helper connection state applies to all retained exchanges because they share that transport, not because there is one active slot; individual waiter cancellation must never set that flag. Both decisions are documented in source.

The review's sequencing point is accepted: U2 can proceed without rerunning the client probe. Repeat U0 against the target client before U4/U5 integration. No live model calls were made to address this review. Claude's commit remains in history; this is a follow-up, not an amendment or revert.

## Integration responsibilities still outstanding

- U2: actual provider process supervision and cleanup proof.
- U3: authenticated scope, serialized app-wide admission, memory reservations/limits, canonical fingerprint generation, timers and waiter ownership, expiry checks before provider submission, cursor-to-index validation, and physical payload removal. The helpers accept explicit evidence from that controller; they do not enforce transport authority themselves.
- U4/U5: MCP transport and main/preload wiring.
- U6+: operator confirmation, safe launch configuration, metadata/UI wiring, and Comms presentation.
- Repeat U0 against the target client before integration/activation. The original runtime pass is for 2.1.267; 2.1.269 has static review evidence only.

No live model calls were made during U1. No merge or remote publication is part of this checkpoint. The next planned unit is U2.
