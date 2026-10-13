import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDataMcpServer } from './dataServer';
import { stopAllQueries } from './runQuery';

// Executable entry only. Import dataServer for side-effect-free testing.
const aetherDir = join(homedir(), '.aether-os');
const server = createDataMcpServer({
  dbPath: join(aetherDir, 'collector.db'),
  dashboardsDir: join(aetherDir, 'dashboards'),
  now: () => Date.now(),
});
const close = () => { stopAllQueries(); void server.close(); };
// Mirrors communicationBridge/mcpEntry.ts. MCP clients keep stdin open for the
// session; closing on 'end' can abort in-flight tool calls of a client that closes stdin early.
process.stdin.once('end', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; close(); });
