/**
 * Config-edit tools. These use Companion's INTERNAL tRPC API, not the documented HTTP API.
 * They are refused unless COMPANION_ALLOW_WRITES=true and COMPANION_ALLOW_CONFIG_EDITS=true.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BACKGROUND_ELEMENT_ID,
  DEFAULT_STEP_ID,
  DEFINITION_ID_RE,
  ENTITY_ID_RE,
  locateEntity,
  MAX_OPTIONS,
  newOverrideId,
  MAX_PAGES_PER_CREATE,
  OPTION_KEY_RE,
  PAGE_NAME_MAX,
  TEXT_ELEMENT_ID,
  type ButtonSummary,
  type EntityLocation,
} from '../companion-config.js';
import { PAGE_MAX, PAGE_MIN, STYLE_TEXT_MAX } from '../companion-client.js';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import {
  evaluateConfigEdit,
  evaluatePageCreate,
  isConfigReadEnabled,
  locationKey,
  WriteLimiter,
} from '../safety.js';
import { INTERNAL_API_NOTE, makePerformWrite, refused } from './config-write.js';
import {
  columnSchema,
  confirmSchema,
  connectionIdSchema,
  dryRunSchema,
  hexColourSchema,
  pageSchema,
  rowSchema,
} from './schemas.js';

const entityIdSchema = z
  .string()
  .regex(ENTITY_ID_RE)
  .describe('Entity id as returned by get_button');
const definitionIdSchema = z
  .string()
  .regex(DEFINITION_ID_RE)
  .describe('Action or feedback definition id from the connection module');
const optionsSchema = z
  .record(z.string().regex(OPTION_KEY_RE), z.unknown())
  .refine((o) => Object.keys(o).length <= MAX_OPTIONS, `at most ${String(MAX_OPTIONS)} options`)
  .describe('Option key/value pairs for the entity');
const actionSetSchema = z
  .enum(['down', 'up', 'rotate_left', 'rotate_right'])
  .default('down')
  .describe('Which action set on step 1 the action belongs to (default down)');

const operationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add_action'),
      connection_id: connectionIdSchema,
      action_id: definitionIdSchema,
      set: actionSetSchema,
      options: optionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_feedback'),
      connection_id: connectionIdSchema,
      feedback_id: definitionIdSchema,
      options: optionsSchema.optional(),
    })
    .strict(),
  z
    .object({ op: z.literal('set_options'), entity_id: entityIdSchema, options: optionsSchema })
    .strict(),
  z.object({ op: z.literal('remove_entity'), entity_id: entityIdSchema }).strict(),
  z
    .object({
      op: z.literal('set_feedback_style'),
      entity_id: entityIdSchema.describe('Feedback entity id as returned by get_button'),
      bgcolor: hexColourSchema
        .optional()
        .describe('Background colour while the feedback is active'),
      color: hexColourSchema.optional().describe('Text colour while the feedback is active'),
      text: z
        .string()
        .max(STYLE_TEXT_MAX)
        .optional()
        .describe('Button text while the feedback is active'),
    })
    .strict()
    .refine(
      (o) => o.bgcolor !== undefined || o.color !== undefined || o.text !== undefined,
      'set at least one of bgcolor, color, text',
    ),
  z
    .object({
      op: z.literal('remove_feedback_style'),
      entity_id: entityIdSchema.describe('Feedback entity id as returned by get_button'),
      properties: z
        .array(z.enum(['bgcolor', 'color', 'text']))
        .min(1)
        .max(3)
        .describe('Which overrides to remove'),
    })
    .strict(),
]);

/** Friendly style names mapped to the default layer element and property on a 5.x button. */
const STYLE_TARGETS = {
  bgcolor: { elementId: BACKGROUND_ELEMENT_ID, elementProperty: 'color' },
  color: { elementId: TEXT_ELEMENT_ID, elementProperty: 'color' },
  text: { elementId: TEXT_ELEMENT_ID, elementProperty: 'text' },
} as const;

function hexToNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

type Operation = z.infer<typeof operationSchema>;

export function registerConfigTools(
  server: McpServer,
  ctx: AppContext,
  limiter: WriteLimiter = new WriteLimiter(),
): void {
  const safety = {
    allowWrites: ctx.config.allowWrites,
    allowConfigEdits: ctx.config.allowConfigEdits,
    allowlist: ctx.allowlist,
  };

  const performWrite = makePerformWrite(ctx, limiter);

  const buttonInput = { page: pageSchema, row: rowSchema, column: columnSchema };

  server.registerTool(
    'get_button',
    {
      title: 'Get button configuration',
      description:
        'Read the configuration of a button at page/row/column: its control id, type, feedbacks, and the actions in each step and action set (with entity ids and options). Use before update_button so you know existing entity ids. Returns found: false for an empty slot. Read only, but needs COMPANION_ALLOW_CONFIG_EDITS=true because it reads the internal API.' +
        INTERNAL_API_NOTE,
      inputSchema: z.object(buttonInput).strict(),
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'get_button', async ({ page, row, column }): Promise<ToolOutcome> => {
      const loc = { page, row, column };
      if (!isConfigReadEnabled(safety)) {
        return refused(
          'reading button config needs COMPANION_ALLOW_CONFIG_EDITS=true',
          { location: loc, reason: 'config edits disabled' },
          false,
        );
      }
      const button = await ctx.configClient.getButton(loc);
      if (button === undefined) {
        return {
          summary: `no button at ${locationKey(loc)}`,
          data: { location: loc, found: false },
        };
      }
      const actionCount = Object.values(button.steps).reduce(
        (n, sets) => n + Object.values(sets).reduce((m, list) => m + list.length, 0),
        0,
      );
      return {
        summary: `${button.type} at ${locationKey(loc)} [${button.controlId}]: ${String(actionCount)} actions, ${String(button.feedbacks.length)} feedbacks`,
        data: { location: loc, found: true, ...button },
        logDetail: `button at ${locationKey(loc)} read`,
      };
    }),
  );

  server.registerTool(
    'create_button',
    {
      title: 'Create button',
      description:
        'Create an empty button at an allowlisted page/row/column. If a button already exists there it is REPLACED with an empty one (all its actions and feedbacks are lost), so this is treated as destructive and always needs confirm: true. dry_run defaults to true. Then use update_button and set_button_style to configure it.' +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({ ...buttonInput, dry_run: dryRunSchema, confirm: confirmSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'create_button',
      async ({ page, row, column, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const decision = evaluateConfigEdit(safety, loc, { confirm, destructive: true });
        if (!decision.allowed) {
          return refused(decision.reason, { location: loc, reason: decision.reason }, dry_run);
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would reset ${key} ("${decision.entry.label}") to a new empty button. Nothing sent.`,
            data: { location: loc, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'create_button',
          `config ${key}`,
          { page, row, column, confirm },
          `about to create button at ${key}`,
          { location: loc },
          async () => {
            const controlId = await ctx.configClient.createButton(loc, decision.auth);
            return {
              summary:
                controlId === undefined
                  ? `Companion accepted the create but no control appeared at ${key}. Verify in Companion.`
                  : `created empty button at ${key} [${controlId}]`,
              data: { location: loc, dryRun: false, sent: true, controlId: controlId ?? null },
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'delete_button',
    {
      title: 'Delete button',
      description:
        'Delete the button at an allowlisted page/row/column, leaving the slot empty. Destructive: always needs confirm: true. dry_run defaults to true.' +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({ ...buttonInput, dry_run: dryRunSchema, confirm: confirmSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'delete_button',
      async ({ page, row, column, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const decision = evaluateConfigEdit(safety, loc, { confirm, destructive: true });
        if (!decision.allowed) {
          return refused(decision.reason, { location: loc, reason: decision.reason }, dry_run);
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would delete the button at ${key} ("${decision.entry.label}"). Nothing sent.`,
            data: { location: loc, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'delete_button',
          `config ${key}`,
          { page, row, column, confirm },
          `about to delete button at ${key}`,
          { location: loc },
          async () => {
            await ctx.configClient.deleteButton(loc, decision.auth);
            return {
              summary: `deleted button at ${key}. Remember to remove or update its allowlist entry.`,
              data: { location: loc, dryRun: false, sent: true },
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'update_button',
    {
      title: 'Update button actions and feedbacks',
      description:
        'Apply a list of operations, in order, to the button at an allowlisted page/row/column: add_action (to a step 1 action set), add_feedback, set_options on an existing entity, remove_entity, set_feedback_style (background colour, text colour and/or text the button shows while a feedback is active, as #rrggbb), remove_feedback_style. Call get_button first to learn entity ids and existing style overrides. Find action and feedback definition ids in the connection module documentation. To change text or colours use set_button_style instead. Each operation runs once; a failure stops the list and reports what was done. remove_entity is destructive and makes the whole call need confirm: true. dry_run defaults to true.' +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({
          ...buttonInput,
          operations: z.array(operationSchema).min(1).max(20),
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'update_button',
      async ({ page, row, column, operations, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const destructive = operations.some((o) => o.op === 'remove_entity');
        const decision = evaluateConfigEdit(safety, loc, { confirm, destructive });
        if (!decision.allowed) {
          return refused(decision.reason, { location: loc, reason: decision.reason }, dry_run);
        }
        const plan = operations.map((o) => o.op);
        if (dry_run) {
          return {
            summary: `DRY RUN: would apply [${plan.join(', ')}] to ${key} ("${decision.entry.label}"). Nothing sent.`,
            data: { location: loc, operations, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'update_button',
          `config ${key}`,
          { page, row, column, operations: plan, confirm },
          `about to apply [${plan.join(', ')}] at ${key}`,
          { location: loc, operations: plan },
          async () => {
            const button = await ctx.configClient.getButton(loc);
            if (button === undefined) {
              return {
                summary: `no button at ${key}. Use create_button first.`,
                data: { location: loc, dryRun: false, sent: false, found: false },
                dryRun: false,
              };
            }
            const results: Record<string, unknown>[] = [];
            for (const op of operations) {
              const r = await applyOperation(op, button, loc);
              results.push(r);
              if (r.ok !== true) {
                break;
              }
            }
            const done = results.filter((r) => r.ok === true).length;
            return {
              summary: `${String(done)} of ${String(operations.length)} operations applied at ${key}${done < operations.length ? ', stopped at a failure' : ''}. Use get_button to confirm.`,
              data: {
                location: loc,
                controlId: button.controlId,
                dryRun: false,
                sent: true,
                results,
              },
              dryRun: false,
            };
          },
        );

        async function applyOperation(
          op: Operation,
          button: ButtonSummary,
          at: typeof loc,
        ): Promise<Record<string, unknown>> {
          if (!decision.allowed) {
            return { op: op.op, ok: false, error: 'not authorised' };
          }
          const auth = decision.auth;
          const id = button.controlId;
          switch (op.op) {
            case 'add_action': {
              const where: EntityLocation = { stepId: DEFAULT_STEP_ID, setId: op.set };
              const entityId = await ctx.configClient.addEntity(
                at,
                id,
                where,
                'action',
                op.connection_id,
                op.action_id,
                auth,
              );
              if (entityId === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: 'Companion did not add the action (unknown connection or action id?)',
                };
              }
              const failed = await setOptions(at, id, where, entityId, op.options ?? {}, auth);
              return {
                op: op.op,
                ok: failed.length === 0,
                entityId,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'add_feedback': {
              const entityId = await ctx.configClient.addEntity(
                at,
                id,
                'feedbacks',
                'feedback',
                op.connection_id,
                op.feedback_id,
                auth,
              );
              if (entityId === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: 'Companion did not add the feedback (unknown connection or feedback id?)',
                };
              }
              const failed = await setOptions(
                at,
                id,
                'feedbacks',
                entityId,
                op.options ?? {},
                auth,
              );
              return {
                op: op.op,
                ok: failed.length === 0,
                entityId,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'set_options': {
              const where = locateEntity(button, op.entity_id);
              if (where === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `entity ${op.entity_id} not found on this button`,
                };
              }
              const failed = await setOptions(at, id, where, op.entity_id, op.options, auth);
              return {
                op: op.op,
                ok: failed.length === 0,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'remove_entity': {
              const where = locateEntity(button, op.entity_id);
              if (where === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `entity ${op.entity_id} not found on this button`,
                };
              }
              const ok = await ctx.configClient.removeEntity(at, id, where, op.entity_id, auth);
              return {
                op: op.op,
                ok,
                ...(ok ? {} : { error: 'Companion did not remove the entity' }),
              };
            }
            case 'set_feedback_style': {
              const fb = button.feedbacks.find((f) => f.id === op.entity_id);
              if (fb === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `feedback ${op.entity_id} not found on this button`,
                };
              }
              const wanted: [keyof typeof STYLE_TARGETS, string | number][] = [];
              if (op.bgcolor !== undefined) {
                wanted.push(['bgcolor', hexToNumber(op.bgcolor)]);
              }
              if (op.color !== undefined) {
                wanted.push(['color', hexToNumber(op.color)]);
              }
              if (op.text !== undefined) {
                wanted.push(['text', op.text]);
              }
              const missing = wanted
                .map(([name]) => STYLE_TARGETS[name].elementId)
                .filter((el) => !hasLayer(button, el));
              if (missing.length > 0) {
                return {
                  op: op.op,
                  ok: false,
                  error: `button has no ${[...new Set(missing)].join(', ')} layer, edit it in Companion`,
                };
              }
              const failed: string[] = [];
              for (const [name, value] of wanted) {
                const target = STYLE_TARGETS[name];
                const existing = fb.styleOverrides?.find(
                  (o) =>
                    o.elementId === target.elementId &&
                    o.elementProperty === target.elementProperty,
                );
                const ok = await ctx.configClient.replaceStyleOverride(
                  at,
                  id,
                  fb.id,
                  { overrideId: existing?.overrideId ?? newOverrideId(), ...target, value },
                  auth,
                );
                if (!ok) {
                  failed.push(name);
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                ...(failed.length ? { failedProperties: failed } : {}),
              };
            }
            case 'remove_feedback_style': {
              const fb = button.feedbacks.find((f) => f.id === op.entity_id);
              if (fb === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `feedback ${op.entity_id} not found on this button`,
                };
              }
              const failed: string[] = [];
              const notSet: string[] = [];
              for (const name of op.properties) {
                const target = STYLE_TARGETS[name];
                const existing = fb.styleOverrides?.find(
                  (o) =>
                    o.elementId === target.elementId &&
                    o.elementProperty === target.elementProperty,
                );
                if (existing === undefined) {
                  notSet.push(name);
                  continue;
                }
                const ok = await ctx.configClient.removeStyleOverride(
                  at,
                  id,
                  fb.id,
                  existing.overrideId,
                  auth,
                );
                if (!ok) {
                  failed.push(name);
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                ...(failed.length ? { failedProperties: failed } : {}),
                ...(notSet.length ? { notSet } : {}),
              };
            }
          }
        }

        async function setOptions(
          at: typeof loc,
          id: string,
          where: EntityLocation,
          entityId: string,
          options: Record<string, unknown>,
          auth: Parameters<typeof ctx.configClient.setEntityOption>[6],
        ): Promise<string[]> {
          const failed: string[] = [];
          for (const [k, v] of Object.entries(options)) {
            const ok = await ctx.configClient.setEntityOption(at, id, where, entityId, k, v, auth);
            if (!ok) {
              failed.push(k);
            }
          }
          return failed;
        }
      },
    ),
  );

  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description:
        `Insert one or more new empty pages at a position (existing pages from that position shift up). Needs "pages_create": true in the allowlist, config edits enabled, dry_run: false and confirm: true. Up to ${String(MAX_PAGES_PER_CREATE)} pages per call. Note: inserting a page renumbers later pages, which makes allowlist entries on those pages point at different buttons. Review the allowlist afterwards.` +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({
          as_page_number: z
            .number()
            .int()
            .min(PAGE_MIN)
            .max(PAGE_MAX + 1)
            .describe('1-based position for the first new page'),
          names: z.array(z.string().max(PAGE_NAME_MAX)).min(1).max(MAX_PAGES_PER_CREATE),
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'create_page',
      async ({ as_page_number, names, dry_run, confirm }): Promise<ToolOutcome> => {
        const decision = evaluatePageCreate(safety, { confirm });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { asPageNumber: as_page_number, names, reason: decision.reason },
            dry_run,
          );
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would insert ${String(names.length)} page(s) at position ${String(as_page_number)}: ${names.join(', ')}. Nothing sent.`,
            data: { asPageNumber: as_page_number, names, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'create_page',
          'pages',
          { asPageNumber: as_page_number, count: names.length, confirm },
          `about to insert ${String(names.length)} page(s) at ${String(as_page_number)}`,
          { asPageNumber: as_page_number, names },
          async () => {
            await ctx.configClient.createPages(as_page_number, names, decision.auth);
            const total = await ctx.configClient.pageCount();
            return {
              summary: `inserted ${String(names.length)} page(s) at ${String(as_page_number)}. Companion now has ${String(total)} pages. Review the allowlist for shifted page numbers.`,
              data: {
                asPageNumber: as_page_number,
                names,
                dryRun: false,
                sent: true,
                totalPages: total,
              },
              dryRun: false,
            };
          },
        );
      },
    ),
  );
}

/** An empty layer list means the snapshot carried no style, so do not block on it. */
function hasLayer(button: ButtonSummary, elementId: string): boolean {
  return button.layers.length === 0 || button.layers.some((l) => l.id === elementId);
}
