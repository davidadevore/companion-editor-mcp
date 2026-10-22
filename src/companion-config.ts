/**
 * Config-edit operations against Companion's internal tRPC API.
 * Originally written from the Companion source at tag v5.0.7:
 *   companion/lib/Page/Controller.ts, companion/lib/Controls/ControlsTrpcRouter.ts,
 *   companion/lib/Controls/EntitiesTrpcRouter.ts, shared-lib/lib/Model/*.ts
 * Updated for 5.1.0 from the 5.1.0 web UI's own tRPC calls and live read-only snapshots:
 * resetControls takes a list of locations, entity option values are wrapped as
 * { value, isExpression }, triggers store `actions` and `condition`, feedback styling is
 * a list of style overrides on layer elements, and trigger event options are plain values.
 * Everything Companion returns is validated; a mismatch fails closed.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { WriteAuthorisation, type ButtonLocation } from './authorisation.js';
import {
  COLUMN_MAX,
  COLUMN_MIN,
  CompanionError,
  CONNECTION_ID_RE,
  PAGE_MAX,
  PAGE_MIN,
  ROW_MAX,
  ROW_MIN,
} from './companion-client.js';
import type { TrpcClient } from './trpc-client.js';

/** Button control type in Companion 5.0.7. Older versions used 'button'. */
export const BUTTON_CONTROL_TYPE = 'button-layered';
export const DEFAULT_STEP_ID = '0';
export const PAGE_NAME_MAX = 64;
export const MAX_PAGES_PER_CREATE = 10;
export const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Control ids look like "bank:Oh_9f4jps0pmEIyxY1hiO".
export const CONTROL_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
export const DEFINITION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const OPTION_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_OPTIONS = 20;

export type EntityKind = 'action' | 'feedback';
export type ActionSetId = 'down' | 'up' | 'rotate_left' | 'rotate_right';
export type EntityLocation = 'feedbacks' | { readonly stepId: string; readonly setId: ActionSetId };
/** Trigger conditions live in 'feedbacks', trigger actions in 'trigger_actions'. */
export type TriggerEntityLocation = 'feedbacks' | 'trigger_actions';
export const EVENT_TYPE_RE = /^[A-Za-z0-9_]{1,64}$/;
export const ELEMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const TRIGGER_NAME_MAX = 128;
// Default layer element ids on a 5.x layered button.
export const BACKGROUND_ELEMENT_ID = 'box0';
export const TEXT_ELEMENT_ID = 'text0';

const pagesInitSchema = z.object({
  type: z.literal('init'),
  order: z.array(z.string().max(128)).max(PAGE_MAX),
  pages: z.record(
    z.string(),
    z.object({
      name: z.string().max(256).optional(),
      controls: z.record(z.string(), z.record(z.string(), z.string().max(128))).optional(),
    }),
  ),
});

const styleOverrideSchema = z.object({
  overrideId: z.string().max(128),
  elementId: z.string().max(128),
  elementProperty: z.string().max(128),
  override: z.unknown(),
});

export type StyleOverride = z.infer<typeof styleOverrideSchema>;

const entitySchema = z.object({
  id: z.string().max(128),
  type: z.enum(['action', 'feedback']),
  connectionId: z.string().max(128),
  definitionId: z.string().max(256),
  options: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
  headline: z.string().max(256).optional(),
  isInverted: z.unknown().optional(),
  styleOverrides: z.array(styleOverrideSchema).max(200).optional(),
  children: z.record(z.string(), z.array(z.unknown())).optional(),
});

export type Entity = z.infer<typeof entitySchema>;

const buttonConfigSchema = z.object({
  type: z.string().max(64),
  feedbacks: z.array(entitySchema).max(500).optional(),
  steps: z
    .record(
      z.string(),
      z.object({
        action_sets: z.record(z.string(), z.array(entitySchema).max(500).nullable()).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  style: z
    .object({
      layers: z
        .array(
          z.object({
            id: z.string().max(128),
            type: z.string().max(64),
            name: z.string().max(256).optional(),
          }),
        )
        .max(200)
        .optional(),
    })
    .optional(),
});

const controlInitSchema = z.object({
  type: z.literal('init'),
  config: buttonConfigSchema,
});

const triggerListSchema = z.object({
  type: z.literal('init'),
  triggers: z.record(
    z.string(),
    z.object({
      name: z.string().max(256),
      enabled: z.boolean(),
      sortOrder: z.number().optional(),
      description: z.string().max(2000).optional(),
      lastExecuted: z.number().nullable().optional(),
      collectionId: z.string().max(128).nullable().optional(),
    }),
  ),
});

const triggerEventSchema = z.object({
  id: z.string().max(128),
  type: z.string().max(64),
  enabled: z.boolean().optional(),
  headline: z.string().max(256).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const triggerInitSchema = z.object({
  type: z.literal('init'),
  config: z.object({
    type: z.literal('trigger'),
    options: z.object({
      name: z.string().max(256),
      enabled: z.boolean(),
      sortOrder: z.number().optional(),
      collectionId: z.string().max(128).nullable().optional(),
    }),
    actions: z.array(entitySchema).max(500),
    condition: z.array(entitySchema).max(500),
    events: z.array(triggerEventSchema).max(100),
  }),
});

export interface TriggerListItem {
  readonly controlId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly collectionId: string | null;
  readonly lastExecuted: number | null;
}

export interface TriggerEvent {
  readonly id: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface TriggerSummary {
  readonly controlId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly collectionId: string | null;
  readonly events: readonly TriggerEvent[];
  readonly conditions: readonly EntitySummary[];
  readonly actions: readonly EntitySummary[];
}

export interface LayerSummary {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
}

export interface ButtonSummary {
  readonly controlId: string;
  readonly type: string;
  readonly feedbacks: readonly EntitySummary[];
  readonly steps: Readonly<Record<string, Readonly<Record<string, readonly EntitySummary[]>>>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly layers: readonly LayerSummary[];
}

export interface EntitySummary {
  readonly id: string;
  readonly kind: EntityKind;
  readonly connectionId: string;
  readonly definitionId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
  readonly headline?: string;
  readonly inverted?: boolean;
  readonly styleOverrides?: readonly StyleOverride[];
}

function summariseEntity(e: Entity): EntitySummary {
  return {
    id: e.id,
    kind: e.type,
    connectionId: e.connectionId,
    definitionId: e.definitionId,
    options: e.options ?? {},
    disabled: e.disabled ?? false,
    ...(e.headline === undefined ? {} : { headline: e.headline }),
    ...(e.type === 'feedback' ? { inverted: unwrapBoolean(e.isInverted) } : {}),
    ...(e.styleOverrides === undefined ? {} : { styleOverrides: e.styleOverrides }),
  };
}

function unwrapBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'object' && v !== null && 'value' in v) {
    return v.value === true;
  }
  return false;
}

/** Companion 5.1 stores entity option values as { value, isExpression }. */
export function wrapValue(value: unknown): { value: unknown; isExpression: boolean } {
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    'value' in value &&
    'isExpression' in value &&
    typeof (value as { isExpression: unknown }).isExpression === 'boolean'
  ) {
    return value as { value: unknown; isExpression: boolean };
  }
  return { value, isExpression: false };
}

/** Same alphabet and length as the nanoid ids Companion generates. */
export function newOverrideId(): string {
  return randomBytes(16).toString('base64url').slice(0, 21);
}

function requireTriggerAuth(
  auth: WriteAuthorisation,
  controlId: string | null,
  what: string,
): void {
  if (!(auth instanceof WriteAuthorisation) || !auth.coversTrigger(controlId)) {
    throw new CompanionError('malformed', `${what} not authorised by the safety layer`);
  }
}

function assertLocation(loc: ButtonLocation): {
  pageNumber: number;
  row: number;
  column: number;
} {
  const ok =
    Number.isInteger(loc.page) &&
    loc.page >= PAGE_MIN &&
    loc.page <= PAGE_MAX &&
    Number.isInteger(loc.row) &&
    loc.row >= ROW_MIN &&
    loc.row <= ROW_MAX &&
    Number.isInteger(loc.column) &&
    loc.column >= COLUMN_MIN &&
    loc.column <= COLUMN_MAX;
  if (!ok) {
    throw new CompanionError('malformed', 'button location out of range');
  }
  return { pageNumber: loc.page, row: loc.row, column: loc.column };
}

function requireButtonAuth(auth: WriteAuthorisation, loc: ButtonLocation, what: string): void {
  if (!(auth instanceof WriteAuthorisation) || !auth.coversButton(loc)) {
    throw new CompanionError('malformed', `${what} not authorised by the safety layer`);
  }
}

function assertPattern(value: string, re: RegExp, label: string): string {
  if (!re.test(value)) {
    throw new CompanionError('malformed', `${label} contains invalid characters or is too long`);
  }
  return value;
}

function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 4) {
    return false;
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length <= 100 && v.every((x) => isJsonValue(x, depth + 1));
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length <= 50 && entries.every(([, x]) => isJsonValue(x, depth + 1));
  }
  return false;
}

export class CompanionConfigClient {
  readonly #trpc: TrpcClient;

  constructor(trpc: TrpcClient) {
    this.#trpc = trpc;
  }

  /** Returns the control id at a location, or undefined if the slot is empty. */
  async resolveControlId(loc: ButtonLocation): Promise<string | undefined> {
    assertLocation(loc);
    const parsed = pagesInitSchema.safeParse(await this.#trpc.first('pages.watch'));
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion pages snapshot had an unexpected shape');
    }
    const pageId = parsed.data.order[loc.page - 1];
    if (pageId === undefined) {
      return undefined;
    }
    const page = parsed.data.pages[pageId];
    const id = page?.controls?.[String(loc.row)]?.[String(loc.column)];
    return id === undefined || id === '' ? undefined : id;
  }

  async pageCount(): Promise<number> {
    const parsed = pagesInitSchema.safeParse(await this.#trpc.first('pages.watch'));
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion pages snapshot had an unexpected shape');
    }
    return parsed.data.order.length;
  }

  async getButton(loc: ButtonLocation): Promise<ButtonSummary | undefined> {
    const controlId = await this.resolveControlId(loc);
    if (controlId === undefined) {
      return undefined;
    }
    const parsed = controlInitSchema.safeParse(
      await this.#trpc.first('controls.watchControl', { controlId }),
    );
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion control snapshot had an unexpected shape');
    }
    const cfg = parsed.data.config;
    const steps: Record<string, Record<string, EntitySummary[]>> = {};
    for (const [stepId, step] of Object.entries(cfg.steps ?? {})) {
      const sets: Record<string, EntitySummary[]> = {};
      for (const [setId, entities] of Object.entries(step.action_sets ?? {})) {
        sets[setId] = (entities ?? []).map(summariseEntity);
      }
      steps[stepId] = sets;
    }
    return {
      controlId,
      type: cfg.type,
      feedbacks: (cfg.feedbacks ?? []).map(summariseEntity),
      steps,
      options: cfg.options ?? {},
      layers: (cfg.style?.layers ?? []).map((l) => ({
        id: l.id,
        type: l.type,
        ...(l.name === undefined ? {} : { name: l.name }),
      })),
    };
  }

  async createButton(loc: ButtonLocation, auth: WriteAuthorisation): Promise<string | undefined> {
    requireButtonAuth(auth, loc, 'create button');
    const location = assertLocation(loc);
    await this.#trpc.call('mutation', 'controls.resetControls', {
      locations: [location],
      newType: BUTTON_CONTROL_TYPE,
    });
    return this.resolveControlId(loc);
  }

  async deleteButton(loc: ButtonLocation, auth: WriteAuthorisation): Promise<void> {
    requireButtonAuth(auth, loc, 'delete button');
    const location = assertLocation(loc);
    await this.#trpc.call('mutation', 'controls.resetControls', {
      locations: [location],
      newType: null,
    });
  }

  async createPages(
    asPageNumber: number,
    names: readonly string[],
    auth: WriteAuthorisation,
  ): Promise<void> {
    if (!(auth instanceof WriteAuthorisation) || !auth.coversPages()) {
      throw new CompanionError('malformed', 'create page not authorised by the safety layer');
    }
    if (!Number.isInteger(asPageNumber) || asPageNumber < PAGE_MIN || asPageNumber > PAGE_MAX + 1) {
      throw new CompanionError('malformed', 'page number out of range');
    }
    if (names.length === 0 || names.length > MAX_PAGES_PER_CREATE) {
      throw new CompanionError(
        'malformed',
        `1 to ${String(MAX_PAGES_PER_CREATE)} page names required`,
      );
    }
    for (const n of names) {
      if (n.length > PAGE_NAME_MAX) {
        throw new CompanionError('malformed', 'page name too long');
      }
    }
    const result = await this.#trpc.call('mutation', 'pages.insert', {
      asPageNumber,
      pageNames: [...names],
    });
    if (result !== 'ok') {
      throw new CompanionError('malformed', 'Companion did not confirm the page insert');
    }
  }

  async addEntity(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    kind: EntityKind,
    connectionId: string,
    definitionId: string,
    auth: WriteAuthorisation,
  ): Promise<string | undefined> {
    requireButtonAuth(auth, loc, 'add entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.add', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      ownerId: null,
      connectionId: assertPattern(connectionId, CONNECTION_ID_RE, 'connection id'),
      entityType: kind,
      entityDefinition: assertPattern(definitionId, DEFINITION_ID_RE, 'definition id'),
    });
    if (result === null) {
      return undefined;
    }
    if (typeof result !== 'string' || !ENTITY_ID_RE.test(result)) {
      throw new CompanionError('malformed', 'Companion returned an unexpected entity id');
    }
    return result;
  }

  async setEntityOption(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    entityId: string,
    key: string,
    value: unknown,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'set entity option');
    if (!isJsonValue(value)) {
      throw new CompanionError('malformed', 'option value must be plain JSON');
    }
    const result = await this.#trpc.call('mutation', 'controls.entities.setOption', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      key: assertPattern(key, OPTION_KEY_RE, 'option key'),
      value: wrapValue(value),
    });
    return result === true;
  }

  async removeEntity(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    entityId: string,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'remove entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.remove', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
    });
    return result === true;
  }

  /**
   * Add or replace one style override on a button feedback. Reusing an existing overrideId
   * replaces it in place; a new id adds one. The value is stored as a plain (non expression) value.
   */
  async replaceStyleOverride(
    loc: ButtonLocation,
    controlId: string,
    entityId: string,
    override: {
      readonly overrideId: string;
      readonly elementId: string;
      readonly elementProperty: string;
      readonly value: unknown;
    },
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'replace style override');
    if (!isJsonValue(override.value)) {
      throw new CompanionError('malformed', 'style value must be plain JSON');
    }
    const result = await this.#trpc.call('mutation', 'controls.entities.replaceStyleOverride', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: 'feedbacks',
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      override: {
        overrideId: assertPattern(override.overrideId, ENTITY_ID_RE, 'override id'),
        elementId: assertPattern(override.elementId, ELEMENT_ID_RE, 'element id'),
        elementProperty: assertPattern(override.elementProperty, OPTION_KEY_RE, 'element property'),
        override: { value: override.value, isExpression: false },
      },
    });
    return result !== false;
  }

  async removeStyleOverride(
    loc: ButtonLocation,
    controlId: string,
    entityId: string,
    overrideId: string,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'remove style override');
    const result = await this.#trpc.call('mutation', 'controls.entities.removeStyleOverride', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: 'feedbacks',
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      overrideId: assertPattern(overrideId, ENTITY_ID_RE, 'override id'),
    });
    return result !== false;
  }

  async listTriggers(): Promise<TriggerListItem[]> {
    const parsed = triggerListSchema.safeParse(await this.#trpc.first('controls.triggers.watch'));
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion trigger list had an unexpected shape');
    }
    return Object.entries(parsed.data.triggers)
      .map(([controlId, t]) => ({
        controlId,
        name: t.name,
        enabled: t.enabled,
        description: t.description ?? '',
        collectionId: t.collectionId ?? null,
        lastExecuted: t.lastExecuted ?? null,
        order: t.sortOrder ?? 0,
      }))
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        controlId: t.controlId,
        name: t.name,
        enabled: t.enabled,
        description: t.description,
        collectionId: t.collectionId,
        lastExecuted: t.lastExecuted,
      }));
  }

  /** Returns undefined if the id is not a trigger Companion knows. */
  async getTrigger(controlId: string): Promise<TriggerSummary | undefined> {
    assertPattern(controlId, CONTROL_ID_RE, 'control id');
    if (!controlId.startsWith('trigger:')) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = await this.#trpc.first('controls.watchControl', { controlId });
    } catch (err) {
      if (err instanceof CompanionError && err.kind === 'http') {
        return undefined;
      }
      throw err;
    }
    const parsed = triggerInitSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion trigger snapshot had an unexpected shape');
    }
    const cfg = parsed.data.config;
    return {
      controlId,
      name: cfg.options.name,
      enabled: cfg.options.enabled,
      collectionId: cfg.options.collectionId ?? null,
      events: cfg.events.map((e) => ({
        id: e.id,
        type: e.type,
        enabled: e.enabled ?? true,
        options: e.options ?? {},
      })),
      conditions: cfg.condition.map(summariseEntity),
      actions: cfg.actions.map(summariseEntity),
    };
  }

  /** Creates an empty, disabled trigger and returns its control id. */
  async createTrigger(auth: WriteAuthorisation): Promise<string> {
    requireTriggerAuth(auth, null, 'create trigger');
    const result = await this.#trpc.call('mutation', 'controls.triggers.create');
    return assertTriggerId(result);
  }

  async cloneTrigger(controlId: string, auth: WriteAuthorisation): Promise<string> {
    requireTriggerAuth(auth, controlId, 'clone trigger');
    const result = await this.#trpc.call('mutation', 'controls.triggers.clone', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
    });
    return assertTriggerId(result);
  }

  async deleteTrigger(controlId: string, auth: WriteAuthorisation): Promise<void> {
    requireTriggerAuth(auth, controlId, 'delete trigger');
    await this.#trpc.call('mutation', 'controls.triggers.delete', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
    });
  }

  /** Trigger name or enabled flag. */
  async setTriggerOption(
    controlId: string,
    key: 'name' | 'enabled',
    value: string | boolean,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'set trigger option');
    if (
      key === 'name'
        ? typeof value !== 'string' || value.length > TRIGGER_NAME_MAX
        : typeof value !== 'boolean'
    ) {
      throw new CompanionError('malformed', `invalid value for trigger ${key}`);
    }
    const result = await this.#trpc.call('mutation', 'controls.setOptionsField', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      key,
      value,
    });
    return result !== false;
  }

  /** Adds an event. Returns the new event id when Companion reports one. */
  async addTriggerEvent(
    controlId: string,
    eventType: string,
    auth: WriteAuthorisation,
  ): Promise<string | undefined> {
    requireTriggerAuth(auth, controlId, 'add trigger event');
    const result = await this.#trpc.call('mutation', 'controls.events.add', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      eventType: assertPattern(eventType, EVENT_TYPE_RE, 'event type'),
    });
    return typeof result === 'string' && ENTITY_ID_RE.test(result) ? result : undefined;
  }

  /** Event options are plain values, not { value, isExpression }. */
  async setTriggerEventOption(
    controlId: string,
    eventId: string,
    key: string,
    value: unknown,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'set trigger event option');
    if (!isJsonValue(value)) {
      throw new CompanionError('malformed', 'option value must be plain JSON');
    }
    const result = await this.#trpc.call('mutation', 'controls.events.setOption', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      eventId: assertPattern(eventId, ENTITY_ID_RE, 'event id'),
      key: assertPattern(key, OPTION_KEY_RE, 'option key'),
      value,
    });
    return result !== false;
  }

  async removeTriggerEvent(
    controlId: string,
    eventId: string,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'remove trigger event');
    const result = await this.#trpc.call('mutation', 'controls.events.remove', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      eventId: assertPattern(eventId, ENTITY_ID_RE, 'event id'),
    });
    return result !== false;
  }

  async addTriggerEntity(
    controlId: string,
    where: TriggerEntityLocation,
    kind: EntityKind,
    connectionId: string,
    definitionId: string,
    auth: WriteAuthorisation,
  ): Promise<string | undefined> {
    requireTriggerAuth(auth, controlId, 'add trigger entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.add', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      ownerId: null,
      connectionId: assertPattern(connectionId, CONNECTION_ID_RE, 'connection id'),
      entityType: kind,
      entityDefinition: assertPattern(definitionId, DEFINITION_ID_RE, 'definition id'),
    });
    if (result === null) {
      return undefined;
    }
    if (typeof result !== 'string' || !ENTITY_ID_RE.test(result)) {
      throw new CompanionError('malformed', 'Companion returned an unexpected entity id');
    }
    return result;
  }

  async setTriggerEntityOption(
    controlId: string,
    where: TriggerEntityLocation,
    entityId: string,
    key: string,
    value: unknown,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'set trigger entity option');
    if (!isJsonValue(value)) {
      throw new CompanionError('malformed', 'option value must be plain JSON');
    }
    const result = await this.#trpc.call('mutation', 'controls.entities.setOption', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      key: assertPattern(key, OPTION_KEY_RE, 'option key'),
      value: wrapValue(value),
    });
    return result !== false;
  }

  async setTriggerConditionInverted(
    controlId: string,
    entityId: string,
    inverted: boolean,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'set trigger condition inverted');
    const result = await this.#trpc.call('mutation', 'controls.entities.setInverted', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: 'feedbacks',
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      isInverted: { value: inverted, isExpression: false },
    });
    return result !== false;
  }

  async removeTriggerEntity(
    controlId: string,
    where: TriggerEntityLocation,
    entityId: string,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireTriggerAuth(auth, controlId, 'remove trigger entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.remove', {
      controlId: assertPattern(controlId, CONTROL_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
    });
    return result !== false;
  }
}

function assertTriggerId(result: unknown): string {
  if (typeof result !== 'string' || !result.startsWith('trigger:') || !CONTROL_ID_RE.test(result)) {
    throw new CompanionError('malformed', 'Companion returned an unexpected trigger id');
  }
  return result;
}

/** Where an entity lives on a trigger, from a snapshot. */
export function locateTriggerEntity(
  trigger: TriggerSummary,
  entityId: string,
): TriggerEntityLocation | undefined {
  if (trigger.conditions.some((e) => e.id === entityId)) {
    return 'feedbacks';
  }
  if (trigger.actions.some((e) => e.id === entityId)) {
    return 'trigger_actions';
  }
  return undefined;
}

/** Find where an entity lives on a button, from a snapshot. */
export function locateEntity(button: ButtonSummary, entityId: string): EntityLocation | undefined {
  if (button.feedbacks.some((f) => f.id === entityId)) {
    return 'feedbacks';
  }
  for (const [stepId, sets] of Object.entries(button.steps)) {
    for (const [setId, entities] of Object.entries(sets)) {
      if (entities.some((e) => e.id === entityId)) {
        if (
          setId === 'down' ||
          setId === 'up' ||
          setId === 'rotate_left' ||
          setId === 'rotate_right'
        ) {
          return { stepId, setId };
        }
      }
    }
  }
  return undefined;
}
