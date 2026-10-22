import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import {
  evaluateConnectionAction,
  evaluatePress,
  evaluateSetVariable,
  evaluateSurfacesRescan,
  locationKey,
  WriteLimiter,
} from '../safety.js';
import {
  columnSchema,
  confirmSchema,
  connectionIdSchema,
  dryRunSchema,
  hexColourSchema,
  pageSchema,
  rowSchema,
  stepSchema,
  styleSizeSchema,
  styleTextSchema,
  variableNameSchema,
  variableValueSchema,
} from './schemas.js';

const LOGGER_UNHEALTHY = 'audit log is not writable, writes are refused until it is';

const buttonActionSchema = z
  .enum(['down', 'up', 'rotate_left', 'rotate_right'])
  .describe(
    'down = run down actions and hold; up = run up actions (release); rotate_left / rotate_right = encoder rotation',
  );

const connectionActionSchema = z
  .enum(['restart', 'enable', 'disable'])
  .describe('restart the connection process, enable it, or disable it');

export function registerWriteTools(
  server: McpServer,
  ctx: AppContext,
  limiter: WriteLimiter = new WriteLimiter(),
): void {
  const safety = { allowWrites: ctx.config.allowWrites, allowlist: ctx.allowlist };

  function refused(summary: string, data: Record<string, unknown>, dryRun: boolean): ToolOutcome {
    return {
      summary: `REFUSED: ${summary}`,
      data: { ...data, refused: true },
      refused: true,
      dryRun,
    };
  }

  /**
   * Shared path for every real write: take the per-target lock, write the attempt line,
   * run the action, release. Callers have already passed the safety decision and dry run.
   */
  async function performWrite(
    tool: string,
    key: string,
    logArgs: Record<string, unknown>,
    intent: string,
    data: Record<string, unknown>,
    run: () => Promise<ToolOutcome>,
  ): Promise<ToolOutcome> {
    const slot = limiter.acquire(key);
    if (!slot.ok) {
      return refused(slot.reason, { ...data, reason: slot.reason }, false);
    }
    try {
      const logged = ctx.logger.log({
        tool,
        args: logArgs,
        outcome: 'attempt',
        allowed: true,
        dryRun: false,
        detail: intent,
      });
      if (!logged) {
        return refused(LOGGER_UNHEALTHY, { ...data, reason: LOGGER_UNHEALTHY }, false);
      }
      return await run();
    } finally {
      slot.release();
    }
  }

  const buttonInput = { page: pageSchema, row: rowSchema, column: columnSchema };

  server.registerTool(
    'press_button',
    {
      title: 'Press button',
      description:
        'Press and release a Companion button at page/row/column. ONLY buttons on the allowlist (see list_allowlist) can be pressed; anything else is refused. Defaults to dry_run: true which reports what would be sent without sending it. To actually press, pass dry_run: false. High risk buttons also need confirm: true. One attempt only, never retried, and the same button cannot be pressed again for 2 seconds. A result of "ok" means Companion accepted the press, not that the downstream device acted; verify by reading a variable back. On timeout or network error the outcome is unknown.',
      inputSchema: z
        .object({ ...buttonInput, dry_run: dryRunSchema, confirm: confirmSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'press_button',
      async ({ page, row, column, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return refused(decision.reason, { location: loc, reason: decision.reason }, dry_run);
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${key}/press for "${entry.label}" (risk ${entry.risk}). Nothing sent.`,
            data: {
              location: loc,
              label: entry.label,
              risk: entry.risk,
              dryRun: true,
              sent: false,
            },
            dryRun: true,
          };
        }
        return performWrite(
          'press_button',
          `button ${key} press`,
          { page, row, column, confirm },
          `about to press "${entry.label}" at ${key}`,
          { location: loc, label: entry.label },
          async () => {
            const result = await ctx.client.pressButton(loc, decision.auth);
            const data = { location: loc, label: entry.label, dryRun: false, sent: true, result };
            if (result === 'no_control') {
              return {
                summary: `Companion reports no button at ${key} ("${entry.label}" in allowlist). Allowlist may be stale.`,
                data,
                dryRun: false,
              };
            }
            return {
              summary: `pressed "${entry.label}" at ${key}. Companion accepted the press.`,
              data,
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'button_action',
    {
      title: 'Button down, up or rotate',
      description:
        'Send a single button phase or encoder rotation to an allowlisted button: "down" runs the down actions and holds, "up" runs the up actions (release), "rotate_left" and "rotate_right" turn an encoder one step. Use press_button for a normal press. Same gates as press_button: allowlist, writes enabled, dry_run defaults to true, high risk needs confirm: true. If you send "down" remember to send "up" afterwards.',
      inputSchema: z
        .object({
          ...buttonInput,
          action: buttonActionSchema,
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'button_action',
      async ({ page, row, column, action, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const apiAction = action.replace('_', '-') as
          'down' | 'up' | 'rotate-left' | 'rotate-right';
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { location: loc, action, reason: decision.reason },
            dry_run,
          );
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${key}/${apiAction} for "${entry.label}" (risk ${entry.risk}). Nothing sent.`,
            data: { location: loc, action, label: entry.label, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'button_action',
          `button ${key} ${action}`,
          { page, row, column, action, confirm },
          `about to send ${apiAction} to "${entry.label}" at ${key}`,
          { location: loc, action, label: entry.label },
          async () => {
            const result = await ctx.client.buttonAction(loc, apiAction, decision.auth);
            const data = {
              location: loc,
              action,
              label: entry.label,
              dryRun: false,
              sent: true,
              result,
            };
            return {
              summary:
                result === 'no_control'
                  ? `Companion reports no button at ${key}. Allowlist may be stale.`
                  : `sent ${apiAction} to "${entry.label}" at ${key}.`,
              data,
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'set_button_step',
    {
      title: 'Set button step',
      description:
        'Set the current step of a multi-step button or encoder at an allowlisted location (steps are 1-based as shown in the Companion editor). Same gates as press_button. Companion answers "Bad step" if the step does not exist on that button.',
      inputSchema: z
        .object({ ...buttonInput, step: stepSchema, dry_run: dryRunSchema, confirm: confirmSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'set_button_step',
      async ({ page, row, column, step, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { location: loc, step, reason: decision.reason },
            dry_run,
          );
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${key}/step?step=${String(step)} for "${entry.label}". Nothing sent.`,
            data: { location: loc, step, label: entry.label, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'set_button_step',
          `button ${key} step`,
          { page, row, column, step, confirm },
          `about to set step ${String(step)} on "${entry.label}" at ${key}`,
          { location: loc, step, label: entry.label },
          async () => {
            const result = await ctx.client.setButtonStep(loc, step, decision.auth);
            return {
              summary:
                result === 'no_control'
                  ? `Companion reports no button at ${key}. Allowlist may be stale.`
                  : `set step ${String(step)} on "${entry.label}" at ${key}.`,
              data: { location: loc, step, label: entry.label, dryRun: false, sent: true, result },
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'set_button_style',
    {
      title: 'Set button style',
      description:
        'Change the text, text colour, background colour and/or font size of an allowlisted button. Colours are "#rrggbb". Size is 7 to 72 or "auto". At least one field is required. This changes the button appearance in Companion until it is changed again. Same gates as press_button.',
      inputSchema: z
        .object({
          ...buttonInput,
          text: styleTextSchema.optional(),
          color: hexColourSchema.optional(),
          bgcolor: hexColourSchema.optional(),
          size: styleSizeSchema.optional(),
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict()
        .refine(
          (v) =>
            v.text !== undefined ||
            v.color !== undefined ||
            v.bgcolor !== undefined ||
            v.size !== undefined,
          'at least one of text, color, bgcolor, size is required',
        ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'set_button_style',
      async ({
        page,
        row,
        column,
        text,
        color,
        bgcolor,
        size,
        dry_run,
        confirm,
      }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const style = {
          ...(text === undefined ? {} : { text }),
          ...(color === undefined ? {} : { color }),
          ...(bgcolor === undefined ? {} : { bgcolor }),
          ...(size === undefined ? {} : { size }),
        };
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { location: loc, style, reason: decision.reason },
            dry_run,
          );
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${key}/style with ${JSON.stringify(style)} for "${entry.label}". Nothing sent.`,
            data: { location: loc, style, label: entry.label, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'set_button_style',
          `button ${key} style`,
          { page, row, column, fields: Object.keys(style), confirm },
          `about to set style on "${entry.label}" at ${key}`,
          { location: loc, style, label: entry.label },
          async () => {
            const result = await ctx.client.setButtonStyle(loc, style, decision.auth);
            return {
              summary:
                result === 'no_control'
                  ? `Companion reports no button at ${key}. Allowlist may be stale.`
                  : `set style on "${entry.label}" at ${key}.`,
              data: { location: loc, style, label: entry.label, dryRun: false, sent: true, result },
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'set_custom_variable',
    {
      title: 'Set custom variable',
      description:
        'Set a Companion custom variable to a non-empty text value. ONLY variable names on the allowlist (see list_allowlist) can be set. Defaults to dry_run: true which reports what would be sent without sending it. Pass dry_run: false to actually write. One attempt only, never retried, and the same variable cannot be written again for 2 seconds. On timeout or network error the outcome is unknown; read the variable back to confirm.',
      inputSchema: z
        .object({ name: variableNameSchema, value: variableValueSchema, dry_run: dryRunSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'set_custom_variable',
      async ({ name, value, dry_run }): Promise<ToolOutcome> => {
        const decision = evaluateSetVariable(safety, name);
        if (!decision.allowed) {
          return refused(decision.reason, { name, reason: decision.reason }, dry_run);
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/custom-variable/${name}/value with a ${String(value.length)} character body. Nothing sent.`,
            data: { name, value, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'set_custom_variable',
          `variable ${name}`,
          { name, valueLength: value.length },
          `about to set custom:${name}`,
          { name },
          async () => {
            const result = await ctx.client.setCustomVariable(name, value, decision.auth);
            const data = { name, value, dryRun: false, sent: true, result };
            if (result === 'not_found') {
              return {
                summary: `Companion reports custom variable "${name}" does not exist. Nothing changed.`,
                data,
                dryRun: false,
              };
            }
            return {
              summary: `set custom:${name} (${String(value.length)} characters)`,
              data,
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'connection_action',
    {
      title: 'Restart, enable or disable a connection',
      description:
        'Restart, enable or disable a Companion connection (module instance) by id. ONLY connection ids listed under "connections" in the allowlist are permitted. Always treated as high risk: needs writes enabled, dry_run: false AND confirm: true. Restarting a connection drops its link to the device for a few seconds; disabling it stops all its actions and feedbacks. Use list_connections to find ids and check status first.',
      inputSchema: z
        .object({
          id: connectionIdSchema,
          action: connectionActionSchema,
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'connection_action',
      async ({ id, action, dry_run, confirm }): Promise<ToolOutcome> => {
        const decision = evaluateConnectionAction(safety, id, { confirm });
        if (!decision.allowed) {
          return refused(decision.reason, { id, action, reason: decision.reason }, dry_run);
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/connections/${id}/${action}. Nothing sent.`,
            data: { id, action, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'connection_action',
          `connection ${id}`,
          { id, action, confirm },
          `about to ${action} connection ${id}`,
          { id, action },
          async () => {
            const result = await ctx.client.connectionAction(id, action, decision.auth);
            const data = { id, action, dryRun: false, sent: true, result };
            const summary =
              result === 'not_found'
                ? `Companion reports connection "${id}" does not exist. Allowlist may be stale.`
                : result === 'inactive'
                  ? `Companion refused: connection "${id}" is inactive and cannot be restarted.`
                  : `${action} accepted for connection "${id}". Check list_connections for the new status.`;
            return { summary, data, dryRun: false };
          },
        );
      },
    ),
  );

  server.registerTool(
    'rescan_surfaces',
    {
      title: 'Rescan USB surfaces',
      description:
        'Ask Companion to rescan for newly attached USB surfaces (Stream Decks and similar). Only permitted when "surfaces_rescan" is true in the allowlist and writes are enabled. dry_run defaults to true. Harmless to connected surfaces, but it is a write.',
      inputSchema: z.object({ dry_run: dryRunSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guard(ctx.logger, 'rescan_surfaces', async ({ dry_run }): Promise<ToolOutcome> => {
      const decision = evaluateSurfacesRescan(safety);
      if (!decision.allowed) {
        return refused(decision.reason, { reason: decision.reason }, dry_run);
      }
      if (dry_run) {
        return {
          summary: 'DRY RUN: would POST /api/surfaces/rescan. Nothing sent.',
          data: { dryRun: true, sent: false },
          dryRun: true,
        };
      }
      return performWrite(
        'rescan_surfaces',
        'surfaces rescan',
        {},
        'about to rescan surfaces',
        {},
        async () => {
          const result = await ctx.client.rescanSurfaces(decision.auth);
          return {
            summary: 'surface rescan accepted by Companion.',
            data: { dryRun: false, sent: true, result },
            dryRun: false,
          };
        },
      );
    }),
  );
}
