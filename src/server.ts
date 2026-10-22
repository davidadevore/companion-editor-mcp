import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from './context.js';
import { registerConfigTools } from './tools/config-tools.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerTriggerTools } from './tools/trigger-tools.js';
import { registerWriteTools } from './tools/write-tools.js';

export const SERVER_NAME = 'companion-editor-mcp';
export const SERVER_VERSION = '0.1.1';

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerConfigTools(server, ctx);
  registerTriggerTools(server, ctx);
  return server;
}
