/**
 * Trigger tools. Like the config-edit tools these use Companion's INTERNAL tRPC API.
 * Reads need COMPANION_ALLOW_CONFIG_EDITS=true. Writes also need COMPANION_ALLOW_WRITES=true
 * and "triggers_edit": true in the allowlist. Deleting, removing events or entities, and
 * enabling a trigger (it can then fire on its own) need confirm: true.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CONTROL_ID_RE,
  DEFINITION_ID_RE,
  ENTITY_ID_RE,
  EVENT_TYPE_RE,
  locateTriggerEntity,
  MAX_OPTIONS,
  OPTION_KEY_RE,
  TRIGGER_NAME_MAX,
  type TriggerSummary,
} from '../companion-config.js';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import { evaluateTriggerEdit, isConfigReadEnabled, WriteLimiter } from '../safety.js';
import { INTERNAL_API_NOTE, makePerformWrite, refused } from './config-write.js';
import { confirmSchema, connectionIdSchema, dryRunSchema } from './schemas.js';

const READ_DISABLED = 'reading triggers needs COMPANION_ALLOW_CONFIG_EDITS=true';

const controlIdSchema = z
  .string()
  .regex(CONTROL_ID_RE)
  .refine((s) => s.startsWith('trigger:'), 'must be a trigger id like "trigger:abc123"')
  .describe('Trigger control id as returned by list_triggers, e.g. "trigger:abc123"');
const entityIdSchema = z
  .string()
  .regex(ENTITY_ID_RE)
  .describe('Action or condition entity id as returned by get_trigger');
const eventIdSchema = z
  .string()
  .regex(ENTITY_ID_RE)
  .describe('Event id as returned by get_trigger');
const definitionIdSchema = z
  .string()
  .regex(DEFINITION_ID_RE)
  .describe('Action or feedback definition id from the connection module');
const optionsSchema = z
  .record(z.string().regex(OPTION_KEY_RE), z.unknown())
  .refine((o) => Object.keys(o).length <= MAX_OPTIONS, `at most ${String(MAX_OPTIONS)} options`)
  .describe('Option key/value pairs');
const nameSchema = z.string().min(1).max(TRIGGER_NAME_MAX).describe('Trigger name');

const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_name'), name: nameSchema }).strict(),
  z.object({ op: z.literal('set_enabled'), enabled: z.boolean() }).strict(),
  z
    .object({
      op: z.literal('add_event'),
      event_type: z
        .string()
        .regex(EVENT_TYPE_RE)
        .describe(
          'Event type, e.g. "interval", "timeofday", "startup", "variable_changed", "condition_true", "condition_false"',
        ),
      options: optionsSchema
        .optional()
        .describe(
          'Event options, plain values, e.g. { "seconds": 60 } or { "variableId": "custom:cue" }',
        ),
    })
    .strict(),
  z
    .object({ op: z.literal('set_event_options'), event_id: eventIdSchema, options: optionsSchema })
    .strict(),
  z.object({ op: z.literal('remove_event'), event_id: eventIdSchema }).strict(),
  z
    .object({
      op: z.literal('add_action'),
      connection_id: connectionIdSchema,
      action_id: definitionIdSchema,
      options: optionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('add_condition'),
      connection_id: connectionIdSchema,
      feedback_id: definitionIdSchema.describe('Boolean feedback definition id'),
      options: optionsSchema.optional(),
      inverted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set_entity_options'),
      entity_id: entityIdSchema,
      options: optionsSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal('set_condition_inverted'),
      entity_id: entityIdSchema,
      inverted: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal('remove_entity'), entity_id: entityIdSchema }).strict(),
]);

type Operation = z.infer<typeof operationSchema>;
type OpResult = Record<string, unknown> & { readonly op: string; readonly ok: boolean };

const DESTRUCTIVE_OPS = new Set<Operation['op']>(['remove_event', 'remove_entity']);

function countSummary(t: TriggerSummary): string {
  return `${String(t.events.length)} events, ${String(t.conditions.length)} conditions, ${String(t.actions.length)} actions`;
}

export function registerTriggerTools(
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

  server.registerTool(
    'list_triggers',
    {
      title: 'List triggers',
      description:
        'List every trigger: control id, name, enabled state, description of its events, collection and last run time. Read only, but needs COMPANION_ALLOW_CONFIG_EDITS=true because it reads the internal API.' +
        INTERNAL_API_NOTE,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'list_triggers', async (): Promise<ToolOutcome> => {
      if (!isConfigReadEnabled(safety)) {
        return refused(READ_DISABLED, { reason: 'config edits disabled' }, false);
      }
      const triggers = await ctx.configClient.listTriggers();
      return {
        summary: [
          `${String(triggers.length)} triggers`,
          ...triggers.map(
            (t) =>
              `${t.controlId} "${t.name}" ${t.enabled ? 'enabled' : 'disabled'}: ${t.description}`,
          ),
        ].join('\n'),
        data: { triggers },
        logDetail: `${String(triggers.length)} triggers listed`,
      };
    }),
  );

  server.registerTool(
    'get_trigger',
    {
      title: 'Get trigger configuration',
      description:
        'Read one trigger: name, enabled state, its events (with ids and options), conditions and actions (with entity ids and options). Call before update_trigger so you know existing ids. Returns found: false for an unknown id. Read only, needs COMPANION_ALLOW_CONFIG_EDITS=true.' +
        INTERNAL_API_NOTE,
      inputSchema: z.object({ control_id: controlIdSchema }).strict(),
      annotations: { readOnlyHint: true },
    },
    guard(ctx.logger, 'get_trigger', async ({ control_id }): Promise<ToolOutcome> => {
      if (!isConfigReadEnabled(safety)) {
        return refused(
          READ_DISABLED,
          { controlId: control_id, reason: 'config edits disabled' },
          false,
        );
      }
      const trigger = await ctx.configClient.getTrigger(control_id);
      if (trigger === undefined) {
        return {
          summary: `no trigger ${control_id}`,
          data: { controlId: control_id, found: false },
        };
      }
      return {
        summary: `trigger ${control_id} "${trigger.name}" ${trigger.enabled ? 'enabled' : 'disabled'}: ${countSummary(trigger)}`,
        data: { found: true, ...trigger },
        logDetail: `trigger ${control_id} read`,
      };
    }),
  );

  server.registerTool(
    'create_trigger',
    {
      title: 'Create trigger',
      description:
        'Create a new, empty, DISABLED trigger with a name. Then use update_trigger to add events, conditions and actions, and set_enabled when it is ready. Needs "triggers_edit" in the allowlist and config edits enabled. dry_run defaults to true.' +
        INTERNAL_API_NOTE,
      inputSchema: z.object({ name: nameSchema, dry_run: dryRunSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(ctx.logger, 'create_trigger', async ({ name, dry_run }): Promise<ToolOutcome> => {
      const decision = evaluateTriggerEdit(safety, null, {
        confirm: false,
        destructive: false,
        enables: false,
      });
      if (!decision.allowed) {
        return refused(decision.reason, { name, reason: decision.reason }, dry_run);
      }
      if (dry_run) {
        return {
          summary: `DRY RUN: would create a disabled trigger "${name}". Nothing sent.`,
          data: { name, dryRun: true, sent: false },
          dryRun: true,
        };
      }
      return performWrite(
        'create_trigger',
        'triggers',
        { name },
        `about to create trigger "${name}"`,
        { name },
        async () => {
          const controlId = await ctx.configClient.createTrigger(decision.auth);
          const named = evaluateTriggerEdit(safety, controlId, {
            confirm: false,
            destructive: false,
            enables: false,
          });
          if (!named.allowed) {
            return refused(named.reason, { controlId, reason: named.reason }, false);
          }
          const nameOk = await ctx.configClient.setTriggerOption(
            controlId,
            'name',
            name,
            named.auth,
          );
          const enabledOk = await ctx.configClient.setTriggerOption(
            controlId,
            'enabled',
            false,
            named.auth,
          );
          return {
            summary:
              nameOk && enabledOk
                ? `created disabled trigger ${controlId} "${name}"`
                : `created trigger ${controlId} but could not set its name or disable it. Check it in Companion.`,
            data: { controlId, name, dryRun: false, sent: true, nameOk, enabledOk },
            dryRun: false,
          };
        },
      );
    }),
  );

  server.registerTool(
    'clone_trigger',
    {
      title: 'Clone trigger',
      description:
        'Duplicate an existing trigger (the clone built into Companion: events, conditions, actions). Returns the new control id. Use update_trigger to rename or change the copy. Needs "triggers_edit" in the allowlist and config edits enabled. dry_run defaults to true.' +
        INTERNAL_API_NOTE,
      inputSchema: z.object({ control_id: controlIdSchema, dry_run: dryRunSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    guard(ctx.logger, 'clone_trigger', async ({ control_id, dry_run }): Promise<ToolOutcome> => {
      const decision = evaluateTriggerEdit(safety, control_id, {
        confirm: false,
        destructive: false,
        enables: false,
      });
      if (!decision.allowed) {
        return refused(
          decision.reason,
          { controlId: control_id, reason: decision.reason },
          dry_run,
        );
      }
      if (dry_run) {
        return {
          summary: `DRY RUN: would clone trigger ${control_id}. Nothing sent.`,
          data: { controlId: control_id, dryRun: true, sent: false },
          dryRun: true,
        };
      }
      return performWrite(
        'clone_trigger',
        `trigger ${control_id}`,
        { controlId: control_id },
        `about to clone trigger ${control_id}`,
        { controlId: control_id },
        async () => {
          const newId = await ctx.configClient.cloneTrigger(control_id, decision.auth);
          const copy = await ctx.configClient.getTrigger(newId);
          return {
            summary: `cloned ${control_id} to ${newId}${copy === undefined ? '' : ` "${copy.name}" (${copy.enabled ? 'ENABLED' : 'disabled'})`}`,
            data: { controlId: control_id, newControlId: newId, dryRun: false, sent: true },
            dryRun: false,
          };
        },
      );
    }),
  );

  server.registerTool(
    'delete_trigger',
    {
      title: 'Delete trigger',
      description:
        'Delete a trigger and everything in it. Destructive: always needs confirm: true. dry_run defaults to true.' +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({ control_id: controlIdSchema, dry_run: dryRunSchema, confirm: confirmSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'delete_trigger',
      async ({ control_id, dry_run, confirm }): Promise<ToolOutcome> => {
        const decision = evaluateTriggerEdit(safety, control_id, {
          confirm,
          destructive: true,
          enables: false,
        });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { controlId: control_id, reason: decision.reason },
            dry_run,
          );
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would delete trigger ${control_id}. Nothing sent.`,
            data: { controlId: control_id, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'delete_trigger',
          `trigger ${control_id}`,
          { controlId: control_id, confirm },
          `about to delete trigger ${control_id}`,
          { controlId: control_id },
          async () => {
            const existing = await ctx.configClient.getTrigger(control_id);
            if (existing === undefined) {
              return {
                summary: `no trigger ${control_id}, nothing deleted`,
                data: { controlId: control_id, dryRun: false, sent: false, found: false },
                dryRun: false,
              };
            }
            await ctx.configClient.deleteTrigger(control_id, decision.auth);
            return {
              summary: `deleted trigger ${control_id} "${existing.name}"`,
              data: { controlId: control_id, dryRun: false, sent: true },
              dryRun: false,
            };
          },
        );
      },
    ),
  );

  server.registerTool(
    'update_trigger',
    {
      title: 'Update trigger',
      description:
        'Apply a list of operations, in order, to one trigger: set_name, set_enabled, add_event, set_event_options, remove_event, add_action, add_condition, set_entity_options (action or condition), set_condition_inverted, remove_entity. Call get_trigger first to learn ids. Event options are plain values; action and condition options are set as plain (non expression) values. A failure stops the list and reports what was done. remove_event, remove_entity and set_enabled true need confirm: true. dry_run defaults to true. Nested actions inside logic groups are not supported.' +
        INTERNAL_API_NOTE,
      inputSchema: z
        .object({
          control_id: controlIdSchema,
          operations: z.array(operationSchema).min(1).max(20),
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'update_trigger',
      async ({ control_id, operations, dry_run, confirm }): Promise<ToolOutcome> => {
        const destructive = operations.some((o) => DESTRUCTIVE_OPS.has(o.op));
        const enables = operations.some((o) => o.op === 'set_enabled' && o.enabled);
        const decision = evaluateTriggerEdit(safety, control_id, { confirm, destructive, enables });
        if (!decision.allowed) {
          return refused(
            decision.reason,
            { controlId: control_id, reason: decision.reason },
            dry_run,
          );
        }
        const plan = operations.map((o) => o.op);
        if (dry_run) {
          return {
            summary: `DRY RUN: would apply [${plan.join(', ')}] to trigger ${control_id}. Nothing sent.`,
            data: { controlId: control_id, operations, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        return performWrite(
          'update_trigger',
          `trigger ${control_id}`,
          { controlId: control_id, operations: plan, confirm },
          `about to apply [${plan.join(', ')}] to trigger ${control_id}`,
          { controlId: control_id, operations: plan },
          async () => {
            const trigger = await ctx.configClient.getTrigger(control_id);
            if (trigger === undefined) {
              return {
                summary: `no trigger ${control_id}. Use create_trigger first.`,
                data: { controlId: control_id, dryRun: false, sent: false, found: false },
                dryRun: false,
              };
            }
            const results: OpResult[] = [];
            for (const op of operations) {
              const r = await applyOperation(op, trigger);
              results.push(r);
              if (!r.ok) {
                break;
              }
            }
            const done = results.filter((r) => r.ok).length;
            const after = await ctx.configClient.getTrigger(control_id);
            return {
              summary: `${String(done)} of ${String(operations.length)} operations applied to ${control_id}${done < operations.length ? ', stopped at a failure' : ''}.${after === undefined ? '' : ` Now ${after.enabled ? 'ENABLED' : 'disabled'}, ${countSummary(after)}.`}`,
              data: {
                controlId: control_id,
                dryRun: false,
                sent: true,
                results,
                ...(after === undefined ? {} : { trigger: after }),
              },
              dryRun: false,
            };
          },
        );

        async function applyOperation(op: Operation, trigger: TriggerSummary): Promise<OpResult> {
          if (!decision.allowed) {
            return { op: op.op, ok: false, error: 'not authorised' };
          }
          const auth = decision.auth;
          const id = trigger.controlId;
          switch (op.op) {
            case 'set_name': {
              const ok = await ctx.configClient.setTriggerOption(id, 'name', op.name, auth);
              return { op: op.op, ok };
            }
            case 'set_enabled': {
              const ok = await ctx.configClient.setTriggerOption(id, 'enabled', op.enabled, auth);
              return { op: op.op, ok };
            }
            case 'add_event': {
              const before = new Set(
                ((await ctx.configClient.getTrigger(id))?.events ?? []).map((e) => e.id),
              );
              const reported = await ctx.configClient.addTriggerEvent(id, op.event_type, auth);
              const eventId =
                reported ??
                (await ctx.configClient.getTrigger(id))?.events.find((e) => !before.has(e.id))?.id;
              if (eventId === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `Companion did not add the event (unknown event type "${op.event_type}"?)`,
                };
              }
              const failed: string[] = [];
              for (const [k, v] of Object.entries(op.options ?? {})) {
                if (!(await ctx.configClient.setTriggerEventOption(id, eventId, k, v, auth))) {
                  failed.push(k);
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                eventId,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'set_event_options': {
              if (!trigger.events.some((e) => e.id === op.event_id)) {
                return {
                  op: op.op,
                  ok: false,
                  error: `event ${op.event_id} not found on this trigger`,
                };
              }
              const failed: string[] = [];
              for (const [k, v] of Object.entries(op.options)) {
                if (!(await ctx.configClient.setTriggerEventOption(id, op.event_id, k, v, auth))) {
                  failed.push(k);
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'remove_event': {
              if (!trigger.events.some((e) => e.id === op.event_id)) {
                return {
                  op: op.op,
                  ok: false,
                  error: `event ${op.event_id} not found on this trigger`,
                };
              }
              const ok = await ctx.configClient.removeTriggerEvent(id, op.event_id, auth);
              return {
                op: op.op,
                ok,
                ...(ok ? {} : { error: 'Companion did not remove the event' }),
              };
            }
            case 'add_action':
            case 'add_condition': {
              const isAction = op.op === 'add_action';
              const where = isAction ? 'trigger_actions' : 'feedbacks';
              const entityId = await ctx.configClient.addTriggerEntity(
                id,
                where,
                isAction ? 'action' : 'feedback',
                op.connection_id,
                isAction ? op.action_id : op.feedback_id,
                auth,
              );
              if (entityId === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `Companion did not add the ${isAction ? 'action' : 'condition'} (unknown connection or definition id?)`,
                };
              }
              const failed: string[] = [];
              for (const [k, v] of Object.entries(op.options ?? {})) {
                if (
                  !(await ctx.configClient.setTriggerEntityOption(id, where, entityId, k, v, auth))
                ) {
                  failed.push(k);
                }
              }
              if (op.op === 'add_condition' && op.inverted === true) {
                if (
                  !(await ctx.configClient.setTriggerConditionInverted(id, entityId, true, auth))
                ) {
                  failed.push('inverted');
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                entityId,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'set_entity_options': {
              const where = locateTriggerEntity(trigger, op.entity_id);
              if (where === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `entity ${op.entity_id} not found on this trigger`,
                };
              }
              const failed: string[] = [];
              for (const [k, v] of Object.entries(op.options)) {
                if (
                  !(await ctx.configClient.setTriggerEntityOption(
                    id,
                    where,
                    op.entity_id,
                    k,
                    v,
                    auth,
                  ))
                ) {
                  failed.push(k);
                }
              }
              return {
                op: op.op,
                ok: failed.length === 0,
                ...(failed.length ? { failedOptions: failed } : {}),
              };
            }
            case 'set_condition_inverted': {
              if (locateTriggerEntity(trigger, op.entity_id) !== 'feedbacks') {
                return {
                  op: op.op,
                  ok: false,
                  error: `condition ${op.entity_id} not found on this trigger`,
                };
              }
              const ok = await ctx.configClient.setTriggerConditionInverted(
                id,
                op.entity_id,
                op.inverted,
                auth,
              );
              return { op: op.op, ok };
            }
            case 'remove_entity': {
              const where = locateTriggerEntity(trigger, op.entity_id);
              if (where === undefined) {
                return {
                  op: op.op,
                  ok: false,
                  error: `entity ${op.entity_id} not found on this trigger`,
                };
              }
              const ok = await ctx.configClient.removeTriggerEntity(id, where, op.entity_id, auth);
              return {
                op: op.op,
                ok,
                ...(ok ? {} : { error: 'Companion did not remove the entity' }),
              };
            }
          }
        }
      },
    ),
  );
}
