import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import { connectionIdSchema, connectionLabelSchema, variableNameSchema } from './schemas.js';

const emptySchema = z.object({}).strict();

const MAX_SUMMARY_VALUE = 2000;

function formatValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_SUMMARY_VALUE ? text.slice(0, MAX_SUMMARY_VALUE) + '...' : text;
}

export function registerReadTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description:
        'Check that the MCP server is alive and report whether writes are enabled. Makes no request to Companion.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'ping', (): Promise<ToolOutcome> => {
      const data = {
        ok: true,
        writesEnabled: ctx.config.allowWrites,
        configEditsEnabled: ctx.config.allowConfigEdits,
        companionHost: ctx.config.companionUrl.host,
        allowlistButtons: ctx.allowlist.buttons.length,
        allowlistVariables: ctx.allowlist.variables.length,
        allowlistAll: ctx.allowlist.all === true,
      };
      return Promise.resolve({
        summary: `companion-editor-mcp is running. Writes ${data.writesEnabled ? 'ENABLED' : 'disabled'}. Config edits ${data.configEditsEnabled ? 'ENABLED' : 'disabled'}. Companion at ${data.companionHost}.`,
        data,
      });
    }),
  );

  server.registerTool(
    'get_custom_variable',
    {
      title: 'Get custom variable',
      description:
        'Read the current value of a Companion custom variable by name (the part after "custom:" without $( )). Use this to confirm show state before or after an action. Returns the value as text or JSON, or found: false if the variable does not exist. Cannot list variables, cannot change them.',
      inputSchema: z.object({ name: variableNameSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'get_custom_variable', async ({ name }): Promise<ToolOutcome> => {
      const result = await ctx.client.getCustomVariable(name);
      if (!result.found) {
        return { summary: `custom variable "${name}" not found`, data: { name, found: false } };
      }
      return {
        summary: `custom:${name} = ${formatValue(result.value)}`,
        data: { name, found: true, value: result.value },
        logDetail: `custom:${name} found`,
      };
    }),
  );

  server.registerTool(
    'get_module_variable',
    {
      title: 'Get module variable',
      description:
        'Read a variable exposed by a Companion connection (module), addressed by connection label and variable name, like $(label:name). Use this to inspect device state such as a switcher program input or a player status. Returns found: false if the connection or variable does not exist. Read only.',
      inputSchema: z
        .object({ connection_label: connectionLabelSchema, name: variableNameSchema })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    guard(
      ctx.logger,
      'get_module_variable',
      async ({ connection_label, name }): Promise<ToolOutcome> => {
        const result = await ctx.client.getModuleVariable(connection_label, name);
        if (!result.found) {
          return {
            summary: `variable ${connection_label}:${name} not found`,
            data: { connectionLabel: connection_label, name, found: false },
          };
        }
        return {
          summary: `${connection_label}:${name} = ${formatValue(result.value)}`,
          data: { connectionLabel: connection_label, name, found: true, value: result.value },
          logDetail: `${connection_label}:${name} found`,
        };
      },
    ),
  );

  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'List every Companion connection (module instance) with its id, label, module and current status. Use this to check which devices are online before a show or to find a connection id. Read only.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'list_connections', async (): Promise<ToolOutcome> => {
      const connections = await ctx.client.listConnections();
      const lines = connections.map(
        (c) =>
          `${c.label} [${c.id}] ${c.moduleId ?? '?'} ${c.enabled ? 'enabled' : 'disabled'} ${c.status?.category ?? 'unknown'}${c.status?.message ? ': ' + c.status.message : ''}`,
      );
      return {
        summary:
          connections.length === 0
            ? 'no connections configured'
            : `${String(connections.length)} connections\n${lines.join('\n')}`,
        data: { connections },
        logDetail: `${String(connections.length)} connections`,
      };
    }),
  );

  server.registerTool(
    'get_connection_status',
    {
      title: 'Get connection status',
      description:
        'Get the status of one Companion connection by id (from list_connections). Returns found: false if the id is unknown. Read only.',
      inputSchema: z.object({ id: connectionIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'get_connection_status', async ({ id }): Promise<ToolOutcome> => {
      const result = await ctx.client.getConnectionStatus(id);
      if (!result.found) {
        return { summary: `connection "${id}" not found`, data: { id, found: false } };
      }
      const c = result.connection;
      return {
        summary: `${c.label} [${c.id}] ${c.enabled ? 'enabled' : 'disabled'} ${c.status?.category ?? 'unknown'}${c.status?.message ? ': ' + c.status.message : ''}`,
        data: { id, found: true, connection: c },
      };
    }),
  );

  server.registerTool(
    'list_allowlist',
    {
      title: 'List allowlist',
      description:
        'Show everything this server is permitted to write: buttons (page/row/column, label, risk), custom variable names, connection ids, and whether surface rescan is enabled. Only these can be used by the write tools. Makes no request to Companion.',
      inputSchema: emptySchema,
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'list_allowlist', (): Promise<ToolOutcome> => {
      const buttons = ctx.allowlist.buttons.map((b) => ({ ...b }));
      const variables = [...ctx.allowlist.variables];
      const connections = [...ctx.allowlist.connections];
      const surfacesRescan = ctx.allowlist.surfaces_rescan;
      const pagesCreate = ctx.allowlist.pages_create;
      const triggersEdit = ctx.allowlist.triggers_edit;
      if (ctx.allowlist.all === true) {
        return Promise.resolve({
          summary:
            'allowlist is "all": every button (risk=low), variable and connection is permitted, surface rescan, page creation and trigger editing enabled',
          data: {
            all: true,
            buttons,
            variables,
            connections,
            surfacesRescan,
            pagesCreate,
            triggersEdit,
          },
        });
      }
      const lines = buttons.map(
        (b) => `${String(b.page)}/${String(b.row)}/${String(b.column)} "${b.label}" risk=${b.risk}`,
      );
      return Promise.resolve({
        summary: [
          `${String(buttons.length)} buttons, ${String(variables.length)} variables, ${String(connections.length)} connections, surface rescan ${surfacesRescan ? 'enabled' : 'disabled'}, page creation ${pagesCreate ? 'enabled' : 'disabled'}, trigger editing ${triggersEdit ? 'enabled' : 'disabled'}`,
          ...lines,
          ...(variables.length > 0 ? ['variables: ' + variables.join(', ')] : []),
          ...(connections.length > 0 ? ['connections: ' + connections.join(', ')] : []),
        ].join('\n'),
        data: { buttons, variables, connections, surfacesRescan, pagesCreate, triggersEdit },
      });
    }),
  );
}
