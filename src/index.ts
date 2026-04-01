#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { closePools } from './db.js';

const server = new McpServer({
  name: 'mssql-mcp',
  version: '1.0.0',
});

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MSSQL MCP Server running on stdio');
}

process.on('SIGINT', async () => {
  await closePools();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closePools();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
