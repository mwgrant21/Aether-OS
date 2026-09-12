import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeMcpServer } from './mcpServer';
import { connectPipeClient } from './pipeServer';
import type { PipeExchangeClient } from './pipeServer';

// Executable entry only. Import mcpServer for side-effect-free embedding/testing.
const endpoint = process.env.AETHER_BRIDGE_PIPE;
const capability = process.env.AETHER_BRIDGE_CAPABILITY;
delete process.env.AETHER_BRIDGE_PIPE;
delete process.env.AETHER_BRIDGE_CAPABILITY;
let connection: Promise<PipeExchangeClient> | undefined;
let closed = false;
let toolsListed = false;
async function client(): Promise<PipeExchangeClient> {
  if (closed || !endpoint || !capability) throw new Error('Bridge unavailable');
  connection ??= connectPipeClient({ endpoint, capability });
  const value = await connection;
  if (closed) { value.close(); throw new Error('Bridge unavailable'); }
  if (toolsListed) value.markToolsListed();
  return value;
}
const server = createBridgeMcpServer({
  ask: async (input, signal) => (await client()).ask(input, signal),
  get: async (input, signal) => (await client()).get(input, signal),
  cancel: async input => (await client()).cancel(input),
}, () => {
  toolsListed = true;
  void client().catch(() => { /* Discovery does not depend on main availability. */ });
});
// One connection attempt per helper lifetime; reconnect requires a new launch.
if (endpoint && capability) void client().catch(() => {});
const close = () => {
  closed = true;
  void connection?.then(value => value.close(), () => {});
  void server.close();
};
process.stdin.once('end', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; close(); });
