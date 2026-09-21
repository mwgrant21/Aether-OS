// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRIDGE_TOOLS } from './mcpServer';
import { BRIDGE_ALLOWED_TOOLS } from './launchConfig';

// The compatibility harness (scripts/communication-compat) stands in for this
// bridge when probing a new Claude CLI before BRIDGE_CLAUDE_VERSION is raised.
// Its entire value is that what it probes is what production ships.
//
// It twice was not, and both times every probe property passed anyway:
//
//   1. The 2.1.270 harness declared readOnlyHint: true and openWorldHint: false
//      while the real tools declare the opposite. A client can treat a
//      read-only tool differently from an open-world one, so it could have
//      preapproved the synthetic tools while prompting for the real ones.
//   2. Its descriptions and inputSchemas were simplified paraphrases -- no
//      `pattern`, no `minLength`, no optional lookup keys, no `wait_ms`. Any of
//      those can change validation, presentation or deferred loading.
//
// The harness now serves bridge-tools.json, generated from BRIDGE_TOOLS, and
// this test deep-compares the two. There is deliberately no paraphrase left to
// drift: regenerate that file, never hand-edit it.
describe('compatibility harness mirrors the production bridge', () => {
  const harnessTools = async () => JSON.parse(
    await readFile(join(process.cwd(), 'scripts/communication-compat/bridge-tools.json'), 'utf8'));

  it('serves byte-identical tool metadata: names, descriptions, schemas, annotations and _meta', async () => {
    // JSON round-trip strips nothing that matters here and normalises the
    // `as const` types, so a deep equality check is exact.
    expect(await harnessTools()).toEqual(JSON.parse(JSON.stringify(BRIDGE_TOOLS)));
  });

  it('carries the schema details a simplified copy loses', async () => {
    // Belt and braces on the fields whose absence caused the second miss. If the
    // deep comparison above is ever loosened, these still fail.
    const [ask, get] = await harnessTools();
    expect(ask.inputSchema.properties.request_key.pattern).toBe('^[A-Za-z0-9_-]{1,64}$');
    expect(ask.inputSchema.properties.question.minLength).toBe(1);
    expect(ask.inputSchema.properties).toHaveProperty('context');
    expect(get.inputSchema.properties.wait_ms).toMatchObject({ type: 'integer', minimum: 1000, maximum: 60000 });
    expect(get.inputSchema.properties).toHaveProperty('cursor');
    expect(get.inputSchema.properties).toHaveProperty('request_key');
  });

  it('exposes exactly the tool names the launch allowlist preapproves', async () => {
    const names = (await harnessTools()).map((t: { name: string }) => t.name);
    expect(names).toEqual(BRIDGE_TOOLS.map(t => t.name));
    // The allowlist is the same three names, MCP-prefixed. A harness probing a
    // name production does not preapprove proves nothing about preapproval.
    expect(BRIDGE_ALLOWED_TOOLS).toEqual(names.map((n: string) => `mcp__aether-bridge__${n}`));
  });
});
