// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRIDGE_TOOLS } from './mcpServer';
import { BRIDGE_ALLOWED_TOOLS } from './launchConfig';

// The compatibility harness (scripts/communication-compat) stands in for this
// bridge when probing a new Claude CLI before BRIDGE_CLAUDE_VERSION is raised.
// Its whole value is that what it probes is what production ships.
//
// It was not. The 2.1.270 harness declared readOnlyHint: true and
// openWorldHint: false while the real tools declare the opposite, and the
// recovered harness inherited that. Those annotations can influence client
// presentation and permission handling, so a client could preapprove the
// synthetic read-only tools while prompting for the real open-world ones -- and
// the probe's exact_preapproval property would pass anyway, certifying a
// version against a tool shape nobody ever runs.
//
// The harness is a standalone Node script with no build step, so it cannot
// import these values. This test compares them instead, and fails the build on
// drift in either direction.
describe('compatibility harness mirrors the production bridge', () => {
  const harness = () => readFile(join(process.cwd(), 'scripts/communication-compat/fake-bridge-server.mjs'), 'utf8');

  it('declares the same tool annotations production does', async () => {
    const source = await harness();
    const literal = source.match(/annotations: \{([^}]*)\}/)?.[1];
    expect(literal, 'no annotations literal found in the harness server').toBeTruthy();

    const parsed = Object.fromEntries(
      literal!.split(',').map(pair => pair.split(':').map(part => part.trim()))
        .filter(([key]) => key)
        .map(([key, value]) => [key, value === 'true']),
    );
    // Production applies one shared annotations object to every bridge tool.
    const production = BRIDGE_TOOLS[0].annotations;
    expect(parsed).toEqual(production);
    for (const tool of BRIDGE_TOOLS) expect(tool.annotations).toEqual(production);
  });

  it('exposes exactly the tool names the launch allowlist preapproves', async () => {
    const source = await harness();
    const names = [...source.matchAll(/\{ name: '([a-z_]+)',/g)].map(m => m[1]);
    expect(names).toEqual(BRIDGE_TOOLS.map(t => t.name));
    // The allowlist is the same three names, MCP-prefixed. If the harness ever
    // probes a name production does not preapprove, the probe proves nothing
    // about preapproval.
    expect(BRIDGE_ALLOWED_TOOLS).toEqual(names.map(n => `mcp__aether-bridge__${n}`));
  });
});
