# Task 7: bridge-only cross-check skill

Base: `92d2313`. Scope: versioned `skills/aether-cross-check/SKILL.md`, with only `name` and `description` frontmatter. No application, launch-policy, settings, or composer changes.

The skill preserves the composer's decoded payload and exact key. For a new plain-text intent it chooses one stable ASCII key without pretending to hash. It allows only the three named Aether bridge tools and supplied context, handles exclusive lookups, sequential server waits, cursor chains, ALIAS_LIMIT recovery, cancellation versus cleanup, partial advice, and error stops without fallback.

## Installation

Install the versioned SKILL.md at user scope: `~/.claude/skills/aether-cross-check/SKILL.md`. Create the destination only if absent; if present, compare it and stop on different content rather than overwriting unrelated user content. Verify installed bytes match the versioned source. Do not modify Claude settings, tool allowlists, or skill-invocation policy.

Installation: **Passed**. Parent installed with FileMode.CreateNew at C:/Users/Matt/.claude/skills/aether-cross-check/SKILL.md after confirming the directory was absent. No existing content was overwritten. Exact-byte comparison passed: 6,171 bytes; source and installed SHA-256 E4B1BDBDFA7AAD5BD7173AD387D6D19A2D4F8D1249024FE076ED6F359F9FD084. No settings or permission changes.

## Verification

- Static frontmatter format: **Passed** using the installed `js-yaml` parser with assertions for delimiters, exactly name/description, matching skill name, and nonempty body (6,171 UTF-8 bytes). Initial attempt with the unavailable `yaml` package failed before validation; no dependency was installed.
- Source-contract review: **Passed** by reading and comparing the skill against `electron/communicationBridge/mcpServer.ts`, `src/shared/communicationLifecycle.ts`, `electron/communicationBridge/exchangeController.ts`, `src/shared/communicationTypes.ts`, and `src/shared/crossCheckIntent.ts`.
- Real connected-Claude discovery and invocation: **Incomplete**, not exercised. Neither file presence nor static validation proves client discovery, permissions, model compliance, or use of the real bridge.
- No model/CLI consultations or Task 8 checks performed. No behavioral claims are derived from text-matching tests; this change contains instructions rather than executable application logic.

Independent source review: **Passed**, no actionable findings. Reviewed artifact hash matches installed artifact. Parent separately ran skill-creator quick_validate.py on both source and installed directory: both reported Skill is valid! These are static checks, not behavioral execution. No application code changed, so no application rebuild or regression suite was run for this instructions-only task. Next: Task 8 combined verification and whole-change review. Actual client discovery/invocation and U9 live-provider gates remain separate and Incomplete.
