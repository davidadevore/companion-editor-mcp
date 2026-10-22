import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { WriteAuthorisation, mintKey } from './authorisation.js';
import {
  COLUMN_MAX,
  COLUMN_MIN,
  CONNECTION_ID_RE,
  PAGE_MAX,
  PAGE_MIN,
  ROW_MAX,
  ROW_MIN,
  VARIABLE_NAME_RE,
  type ButtonLocation,
} from './companion-client.js';

export class AllowlistError extends Error {
  override readonly name = 'AllowlistError';
}

const MAX_ALLOWLIST_BYTES = 256 * 1024;

const buttonEntrySchema = z
  .object({
    page: z.number().int().min(PAGE_MIN).max(PAGE_MAX),
    row: z.number().int().min(ROW_MIN).max(ROW_MAX),
    column: z.number().int().min(COLUMN_MIN).max(COLUMN_MAX),
    label: z.string().min(1).max(80),
    risk: z.enum(['low', 'high']),
  })
  .strict();

const allowlistSchema = z
  .object({
    buttons: z.array(buttonEntrySchema).max(500),
    variables: z.array(z.string().regex(VARIABLE_NAME_RE)).max(500).default([]),
    connections: z.array(z.string().regex(CONNECTION_ID_RE)).max(500).default([]),
    surfaces_rescan: z.boolean().default(false),
    pages_create: z.boolean().default(false),
    triggers_edit: z.boolean().default(false),
  })
  .strict();

export type ButtonEntry = z.infer<typeof buttonEntrySchema>;

export interface Allowlist {
  readonly buttons: readonly ButtonEntry[];
  readonly variables: readonly string[];
  readonly connections: readonly string[];
  readonly surfaces_rescan: boolean;
  readonly pages_create: boolean;
  readonly triggers_edit: boolean;
  /** Set when the allowlist file is the string "all": every button, variable and connection. */
  readonly all?: boolean;
}

const ALLOW_ALL: Allowlist = {
  buttons: [],
  variables: [],
  connections: [],
  surfaces_rescan: true,
  pages_create: true,
  triggers_edit: true,
  all: true,
};

export function locationKey(loc: ButtonLocation): string {
  return `${String(loc.page)}/${String(loc.row)}/${String(loc.column)}`;
}

export function parseAllowlist(text: string): Allowlist {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AllowlistError('allowlist is not valid JSON');
  }
  if (raw === 'all') {
    return ALLOW_ALL;
  }
  const parsed = allowlistSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AllowlistError(`allowlist is invalid: ${issues}`);
  }
  const seen = new Set<string>();
  for (const entry of parsed.data.buttons) {
    const key = locationKey(entry);
    if (seen.has(key)) {
      throw new AllowlistError(`allowlist has a duplicate button entry at ${key}`);
    }
    seen.add(key);
  }
  const vars = new Set<string>();
  for (const name of parsed.data.variables) {
    if (vars.has(name)) {
      throw new AllowlistError(`allowlist has a duplicate variable entry ${name}`);
    }
    vars.add(name);
  }
  const conns = new Set<string>();
  for (const id of parsed.data.connections) {
    if (conns.has(id)) {
      throw new AllowlistError(`allowlist has a duplicate connection entry ${id}`);
    }
    conns.add(id);
  }
  return parsed.data;
}

export function loadAllowlist(filePath: string): Allowlist {
  let text: string;
  try {
    text = readFileSync(filePath, { encoding: 'utf8' });
  } catch {
    throw new AllowlistError('allowlist file is missing or unreadable');
  }
  if (text.length > MAX_ALLOWLIST_BYTES) {
    throw new AllowlistError('allowlist file is too large');
  }
  return parseAllowlist(text);
}

export function getButtonEntry(allowlist: Allowlist, loc: ButtonLocation): ButtonEntry | undefined {
  const entry = allowlist.buttons.find(
    (b) => b.page === loc.page && b.row === loc.row && b.column === loc.column,
  );
  if (entry === undefined && allowlist.all === true) {
    return {
      page: loc.page,
      row: loc.row,
      column: loc.column,
      label: `button ${locationKey(loc)}`,
      risk: 'low',
    };
  }
  return entry;
}

export function isButtonAllowed(allowlist: Allowlist, loc: ButtonLocation): boolean {
  return getButtonEntry(allowlist, loc) !== undefined;
}

export function isVariableAllowed(allowlist: Allowlist, name: string): boolean {
  return allowlist.all === true || allowlist.variables.includes(name);
}

export function isConnectionAllowed(allowlist: Allowlist, id: string): boolean {
  return allowlist.all === true || allowlist.connections.includes(id);
}

export interface SafetyContext {
  readonly allowWrites: boolean;
  readonly allowlist: Allowlist;
  /** Config edits (create/delete buttons, edit actions, create pages) via the internal API. */
  readonly allowConfigEdits?: boolean;
}

export function isConfigEditEnabled(ctx: SafetyContext): boolean {
  return ctx.allowWrites && ctx.allowConfigEdits === true;
}

export function isWriteEnabled(ctx: Pick<SafetyContext, 'allowWrites'>): boolean {
  return ctx.allowWrites;
}

export type PressDecision =
  | { readonly allowed: true; readonly entry: ButtonEntry; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

export type VariableDecision =
  | { readonly allowed: true; readonly name: string; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

export type ConnectionDecision =
  | { readonly allowed: true; readonly id: string; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

export type SurfacesDecision =
  | { readonly allowed: true; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

const WRITES_DISABLED = 'writes are disabled (COMPANION_ALLOW_WRITES is not true)';

export function evaluatePress(
  ctx: SafetyContext,
  loc: ButtonLocation,
  opts: { readonly confirm: boolean },
): PressDecision {
  const entry = getButtonEntry(ctx.allowlist, loc);
  if (entry === undefined) {
    return {
      allowed: false,
      reason: `button ${locationKey(loc)} is not on the allowlist`,
    };
  }
  if (!isWriteEnabled(ctx)) {
    return {
      allowed: false,
      reason: 'writes are disabled (COMPANION_ALLOW_WRITES is not true)',
    };
  }
  if (entry.risk === 'high' && !opts.confirm) {
    return {
      allowed: false,
      reason: `button "${entry.label}" is high risk and requires confirm: true`,
    };
  }
  return {
    allowed: true,
    entry,
    auth: new WriteAuthorisation(mintKey, { kind: 'button', location: { ...loc } }),
  };
}

export function evaluateSetVariable(ctx: SafetyContext, name: string): VariableDecision {
  if (!VARIABLE_NAME_RE.test(name)) {
    return { allowed: false, reason: 'variable name is invalid' };
  }
  if (!isVariableAllowed(ctx.allowlist, name)) {
    return { allowed: false, reason: `variable "${name}" is not on the allowlist` };
  }
  if (!isWriteEnabled(ctx)) {
    return {
      allowed: false,
      reason: 'writes are disabled (COMPANION_ALLOW_WRITES is not true)',
    };
  }
  return { allowed: true, name, auth: new WriteAuthorisation(mintKey, { kind: 'variable', name }) };
}

/** Connection restart, enable and disable are always treated as high risk. */
export function evaluateConnectionAction(
  ctx: SafetyContext,
  id: string,
  opts: { readonly confirm: boolean },
): ConnectionDecision {
  if (!CONNECTION_ID_RE.test(id)) {
    return { allowed: false, reason: 'connection id is invalid' };
  }
  if (!isConnectionAllowed(ctx.allowlist, id)) {
    return { allowed: false, reason: `connection "${id}" is not on the allowlist` };
  }
  if (!isWriteEnabled(ctx)) {
    return { allowed: false, reason: WRITES_DISABLED };
  }
  if (!opts.confirm) {
    return { allowed: false, reason: 'connection actions are high risk and require confirm: true' };
  }
  return { allowed: true, id, auth: new WriteAuthorisation(mintKey, { kind: 'connection', id }) };
}

const CONFIG_EDITS_DISABLED =
  'config edits are disabled (needs COMPANION_ALLOW_WRITES=true and COMPANION_ALLOW_CONFIG_EDITS=true)';

export type TriggerDecision =
  | { readonly allowed: true; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

export type PagesDecision =
  | { readonly allowed: true; readonly auth: WriteAuthorisation }
  | { readonly allowed: false; readonly reason: string };

/**
 * Config edit on a button location. Same allowlist and risk rules as a press, plus the
 * config-edit flag. Destructive edits (delete, remove entity) always require confirm.
 */
export function evaluateConfigEdit(
  ctx: SafetyContext,
  loc: ButtonLocation,
  opts: { readonly confirm: boolean; readonly destructive: boolean },
): PressDecision {
  const entry = getButtonEntry(ctx.allowlist, loc);
  if (entry === undefined) {
    return { allowed: false, reason: `button ${locationKey(loc)} is not on the allowlist` };
  }
  if (!isConfigEditEnabled(ctx)) {
    return { allowed: false, reason: CONFIG_EDITS_DISABLED };
  }
  if ((entry.risk === 'high' || opts.destructive) && !opts.confirm) {
    return {
      allowed: false,
      reason: opts.destructive
        ? `destructive edit of "${entry.label}" requires confirm: true`
        : `button "${entry.label}" is high risk and requires confirm: true`,
    };
  }
  return {
    allowed: true,
    entry,
    auth: new WriteAuthorisation(mintKey, { kind: 'button', location: { ...loc } }),
  };
}

export function evaluatePageCreate(
  ctx: SafetyContext,
  opts: { readonly confirm: boolean },
): PagesDecision {
  if (!ctx.allowlist.pages_create) {
    return {
      allowed: false,
      reason: 'page creation is not enabled in the allowlist (pages_create)',
    };
  }
  if (!isConfigEditEnabled(ctx)) {
    return { allowed: false, reason: CONFIG_EDITS_DISABLED };
  }
  if (!opts.confirm) {
    return { allowed: false, reason: 'page creation requires confirm: true' };
  }
  return { allowed: true, auth: new WriteAuthorisation(mintKey, { kind: 'pages' }) };
}

/**
 * Trigger edit through the internal API. Needs "triggers_edit" in the allowlist and the
 * config-edit flag. Destructive edits, and enabling a trigger (it can then fire on its own),
 * require confirm. controlId null authorises creating a new trigger.
 */
export function evaluateTriggerEdit(
  ctx: SafetyContext,
  controlId: string | null,
  opts: { readonly confirm: boolean; readonly destructive: boolean; readonly enables: boolean },
): TriggerDecision {
  if (!ctx.allowlist.triggers_edit) {
    return {
      allowed: false,
      reason: 'trigger editing is not enabled in the allowlist (triggers_edit)',
    };
  }
  if (!isConfigEditEnabled(ctx)) {
    return { allowed: false, reason: CONFIG_EDITS_DISABLED };
  }
  if (opts.destructive && !opts.confirm) {
    return { allowed: false, reason: 'destructive trigger edits require confirm: true' };
  }
  if (opts.enables && !opts.confirm) {
    return {
      allowed: false,
      reason: 'enabling a trigger lets it fire on its own and requires confirm: true',
    };
  }
  return { allowed: true, auth: new WriteAuthorisation(mintKey, { kind: 'trigger', controlId }) };
}

/** Reading button config uses the internal API, so it is tied to the config-edit flag. */
export function isConfigReadEnabled(ctx: SafetyContext): boolean {
  return ctx.allowConfigEdits === true;
}

export function evaluateSurfacesRescan(ctx: SafetyContext): SurfacesDecision {
  if (!ctx.allowlist.surfaces_rescan) {
    return { allowed: false, reason: 'surface rescan is not enabled in the allowlist' };
  }
  if (!isWriteEnabled(ctx)) {
    return { allowed: false, reason: WRITES_DISABLED };
  }
  return { allowed: true, auth: new WriteAuthorisation(mintKey, { kind: 'surfaces' }) };
}

export const DEFAULT_COOLDOWN_MS = 2000;

export type LimiterDecision =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: string };

/**
 * Serialises writes per target: one in flight at a time, then a cooldown.
 * Stops an LLM from double-firing a button with parallel or rapid calls.
 */
export class WriteLimiter {
  readonly #inFlight = new Set<string>();
  readonly #lastDone = new Map<string, number>();
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(cooldownMs = DEFAULT_COOLDOWN_MS, now: () => number = Date.now) {
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  acquire(key: string): LimiterDecision {
    if (this.#inFlight.has(key)) {
      return { ok: false, reason: `a write to ${key} is already in flight` };
    }
    const last = this.#lastDone.get(key);
    const now = this.#now();
    if (last !== undefined && now - last < this.#cooldownMs) {
      const wait = this.#cooldownMs - (now - last);
      return {
        ok: false,
        reason: `${key} was written ${String(now - last)}ms ago, wait ${String(wait)}ms`,
      };
    }
    this.#inFlight.add(key);
    return {
      ok: true,
      release: () => {
        this.#inFlight.delete(key);
        this.#lastDone.set(key, this.#now());
      },
    };
  }
}
