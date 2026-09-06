// @vitest-environment node
//
// Opt-in LIVE smoke tests. Skipped unless AETHER_LIVE_PROVIDER_SMOKE=1.
//
// Every other test in this directory drives an injected fake built from
// captured output, which is circular by construction: if a real event shape
// was misread, the fake encodes the same misreading and the suite still
// passes. These tests close that gap by talking to the real locally-installed
// CLIs -- and they are exactly why the default-spawn path went unexercised
// long enough to ship `spawn('codex', ...)`, which cannot work on Windows.
//
// Deliberately opt-in, per the broker plan: "real Claude/Codex smoke tests
// remain explicit local opt-in so CI contains no credentials." The Windows CI
// lane runs with this unset and therefore skips the whole file.
//
// These spend no model tokens. They exercise process spawning, the protocol
// handshake, and read-only auth/account probes only -- never a turn.
//
//   AETHER_LIVE_PROVIDER_SMOKE=1 npx vitest run electron/crossEngine/providers/providers.live.test.ts

import { describe, it, expect } from 'vitest';
import { CodexAppServerAdapter } from './codexAppServer';
import { ClaudeHeadlessCliAdapter } from './claudeHeadlessCli';

const LIVE = process.env.AETHER_LIVE_PROVIDER_SMOKE === '1';
const describeLive = LIVE ? describe : describe.skip;

describeLive('LIVE: CodexAppServerAdapter against the real codex app-server', () => {
  it('connects over the default spawn path and reports health', async () => {
    const adapter = new CodexAppServerAdapter();
    try {
      // The default spawn path. Nothing else in this suite covers it, and it
      // is where `spawn('codex')` failed with ENOENT on Windows.
      await adapter.connect();
      const health = await adapter.health();
      expect(['subscription', 'api-key', 'gateway', 'unauthenticated', 'unknown']).toContain(health.authMode);
      // Not asserting ready===true: the point is that the probe completes and
      // classifies, not that this particular machine is logged in.
      expect(typeof health.ready).toBe('boolean');
    } finally {
      await adapter.dispose();
    }
  }, 60_000);

  it('opens and closes a read-only thread', async () => {
    const adapter = new CodexAppServerAdapter();
    try {
      await adapter.connect();
      const threadId = await adapter.newSession({ cwd: process.cwd() });
      expect(threadId).toMatch(/\S/);
      // Cancelling an idle thread must be a no-op, not an error.
      await expect(adapter.cancel(threadId)).resolves.toBeUndefined();
    } finally {
      await adapter.dispose();
    }
  }, 60_000);
});

describeLive('LIVE: ClaudeHeadlessCliAdapter against the real claude CLI', () => {
  it('classifies the real login state without spending tokens', async () => {
    const adapter = new ClaudeHeadlessCliAdapter();
    try {
      await adapter.connect();
      const health = await adapter.health();
      expect(['subscription', 'api-key', 'gateway', 'unauthenticated', 'unknown']).toContain(health.authMode);
      expect(typeof health.ready).toBe('boolean');
      // The probe returns the operator's email and org id; neither may reach
      // ProviderHealth, which other layers may log or persist.
      const serialized = JSON.stringify(health);
      expect(serialized).not.toMatch(/@[\w.-]+\.\w+/);
    } finally {
      await adapter.dispose();
    }
  }, 60_000);
});
