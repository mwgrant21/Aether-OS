import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDataMcpServer } from './dataServer';

// Executable entry only. Import dataServer for side-effect-free testing.
const aetherDir = join(homedir(), '.aether-os');
const server = createDataMcpServer({
  dbPath: join(aetherDir, 'collector.db'),
  dashboardsDir: join(aetherDir, 'dashboards'),
  now: () => Date.now(),
});
const close = () => { void server.close(); };
process.stdin.once('end', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; close(); });
