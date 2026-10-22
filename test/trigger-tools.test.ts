import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAllowlist } from '../src/safety.js';
import { MockCompanion } from './mock-companion.js';
import { MockTrpc } from './mock-trpc.js';
import { startHarness, testAllowlist, textOf, type Harness } from './helpers.js';

const http = new MockCompanion();
const trpc = new MockTrpc();
let h: Harness | undefined;
const H = (): Harness => {
  if (h === undefined) {
    throw new Error('no harness');
  }
  return h;
};

beforeAll(async () => {
  await http.start();
  await trpc.start();
});
afterAll(async () => {
  await trpc.stop();
  await http.stop();
});
beforeEach(() => {
  trpc.reset();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const low = { page: 1, row: 0, column: 0 };
const mutations = (): string[] =>
  trpc.calls.filter((c) => c.method === 'mutation').map((c) => c.path);
const cooldown = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2100));

describe('allowlist triggers_edit', () => {
  it('defaults to false and "all" turns it on', () => {
    expect(parseAllowlist('{"buttons": []}').triggers_edit).toBe(false);
    expect(parseAllowlist('"all"').triggers_edit).toBe(true);
  });
});

describe('trigger tools refuse unless every gate is open', () => {
  it('config edits off: reads and writes refuse, nothing reaches tRPC', async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: false, trpc });
    const calls: [string, Record<string, unknown>][] = [
      ['list_triggers', {}],
      ['get_trigger', { control_id: 'trigger:x' }],
      ['create_trigger', { name: 'T', dry_run: false }],
      ['clone_trigger', { control_id: 'trigger:x', dry_run: false }],
      ['delete_trigger', { control_id: 'trigger:x', dry_run: false, confirm: true }],
      [
        'update_trigger',
        { control_id: 'trigger:x', operations: [{ op: 'set_name', name: 'n' }], dry_run: false },
      ],
    ];
    for (const [tool, args] of calls) {
      const r = await H().call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(textOf(r), tool).toMatch(/CONFIG_EDITS|config edits/);
    }
    expect(trpc.calls).toHaveLength(0);
  });

  it('triggers_edit off in the allowlist refuses writes but still allows reads', async () => {
    h = await startHarness(http, {
      allowWrites: true,
      allowConfigEdits: true,
      trpc,
      allowlist: { ...testAllowlist, triggers_edit: false },
    });
    const r = await H().call('create_trigger', { name: 'T', dry_run: false });
    expect(textOf(r)).toMatch(/triggers_edit/);
    expect(mutations()).toEqual([]);
    const l = await H().call('list_triggers');
    expect(l.isError).toBeFalsy();
  });

  it('rejects a non-trigger control id', async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
    const r = await H().call('get_trigger', { control_id: 'bank:abc' });
    expect(r.isError).toBe(true);
    expect(trpc.calls).toHaveLength(0);
  });
});

describe('trigger read tools', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: false, allowConfigEdits: true, trpc });
  });
  it('lists triggers and reads one', async () => {
    const id = trpc.addTrigger('Floor Close');
    const l = await H().call('list_triggers');
    expect(l.structuredContent).toMatchObject({
      triggers: [{ controlId: id, name: 'Floor Close', enabled: false }],
    });
    const g = await H().call('get_trigger', { control_id: id });
    expect(g.structuredContent).toMatchObject({
      found: true,
      name: 'Floor Close',
      events: [],
      conditions: [],
      actions: [],
    });
    const missing = await H().call('get_trigger', { control_id: 'trigger:nope' });
    expect(missing.structuredContent).toMatchObject({ found: false });
  });
  it('fails closed on an unexpected snapshot shape', async () => {
    trpc.mode = 'badshape';
    const r = await H().call('list_triggers');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/unexpected shape/);
  });
});

describe('trigger write tools', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
  });

  it('create_trigger dry run sends nothing; real run creates it named and disabled', async () => {
    const dry = await H().call('create_trigger', { name: 'Walk in' });
    expect(dry.structuredContent).toMatchObject({ dryRun: true, sent: false });
    expect(mutations()).toEqual([]);
    const r = await H().call('create_trigger', { name: 'Walk in', dry_run: false });
    expect(r.isError).toBeFalsy();
    const id = (r.structuredContent as { controlId: string }).controlId;
    expect(trpc.triggers.get(id)?.options).toMatchObject({ name: 'Walk in', enabled: false });
    expect(mutations()).toEqual([
      'controls.triggers.create',
      'controls.setOptionsField',
      'controls.setOptionsField',
    ]);
    expect(H().logger.entries.filter((e) => e.outcome === 'attempt')).toHaveLength(1);
  });

  it('update_trigger builds events, conditions and actions with the 5.1 value shapes', async () => {
    const id = trpc.addTrigger('T');
    const r = await H().call('update_trigger', {
      control_id: id,
      operations: [
        { op: 'add_event', event_type: 'interval', options: { seconds: 60 } },
        {
          op: 'add_condition',
          connection_id: 'conn1',
          feedback_id: 'variable_value',
          options: { op: 'eq' },
          inverted: true,
        },
        { op: 'add_action', connection_id: 'conn1', action_id: 'program', options: { input: 2 } },
      ],
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/3 of 3 operations applied/);
    const t = trpc.triggers.get(id);
    // event options stay plain, entity options are wrapped
    expect(t?.events[0]).toMatchObject({ type: 'interval', options: { seconds: 60 } });
    expect(t?.condition[0]?.options).toEqual({ op: { value: 'eq', isExpression: false } });
    expect(t?.condition[0]?.isInverted).toEqual({ value: true, isExpression: false });
    expect(t?.actions[0]?.options).toEqual({ input: { value: 2, isExpression: false } });
    expect(trpc.calls.find((c) => c.path === 'controls.entities.add')?.input).toMatchObject({
      entityLocation: 'feedbacks',
      entityType: 'feedback',
    });
    expect(r.structuredContent).toMatchObject({
      results: [
        { op: 'add_event', ok: true, eventId: t?.events[0]?.id },
        { ok: true },
        { ok: true },
      ],
    });
  });

  it('enabling needs confirm; destructive ops need confirm', async () => {
    const id = trpc.addTrigger('T');
    const noConfirm = await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'set_enabled', enabled: true }],
      dry_run: false,
    });
    expect(textOf(noConfirm)).toMatch(/fire on its own.*confirm/);
    const off = await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'set_enabled', enabled: false }],
      dry_run: false,
    });
    expect(off.isError).toBeFalsy();
    await cooldown();
    const on = await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'set_enabled', enabled: true }],
      dry_run: false,
      confirm: true,
    });
    expect(on.isError).toBeFalsy();
    expect(trpc.triggers.get(id)?.options.enabled).toBe(true);

    const removeNoConfirm = await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'remove_event', event_id: 'ev1' }],
      dry_run: false,
    });
    expect(textOf(removeNoConfirm)).toMatch(/destructive.*confirm/);
  }, 10_000);

  it('stops at the first failure and reports what was done', async () => {
    const id = trpc.addTrigger('T');
    const r = await H().call('update_trigger', {
      control_id: id,
      operations: [
        { op: 'set_name', name: 'Renamed' },
        { op: 'add_event', event_type: 'no_such_event' },
        { op: 'set_name', name: 'Never' },
      ],
      dry_run: false,
    });
    expect(textOf(r)).toMatch(/1 of 3 operations applied.*stopped at a failure/);
    expect(trpc.triggers.get(id)?.options.name).toBe('Renamed');
  });

  it('set_entity_options and remove_entity find the entity on either list', async () => {
    const id = trpc.addTrigger('T');
    await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'add_action', connection_id: 'conn1', action_id: 'program' }],
      dry_run: false,
    });
    const actionId = trpc.triggers.get(id)?.actions[0]?.id ?? '';
    await cooldown();
    const r = await H().call('update_trigger', {
      control_id: id,
      operations: [
        { op: 'set_entity_options', entity_id: actionId, options: { input: 5 } },
        { op: 'remove_entity', entity_id: actionId },
      ],
      dry_run: false,
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(trpc.triggers.get(id)?.actions).toHaveLength(0);
    await cooldown();
    const ghost = await H().call('update_trigger', {
      control_id: id,
      operations: [{ op: 'set_condition_inverted', entity_id: 'ghost', inverted: true }],
      dry_run: false,
    });
    expect(textOf(ghost)).toMatch(/0 of 1/);
  }, 10_000);

  it('clone and delete', async () => {
    const id = trpc.addTrigger('Source');
    const c = await H().call('clone_trigger', { control_id: id, dry_run: false });
    expect(c.isError).toBeFalsy();
    const newId = (c.structuredContent as { newControlId: string }).newControlId;
    expect(trpc.triggers.has(newId)).toBe(true);
    const noConfirm = await H().call('delete_trigger', { control_id: newId, dry_run: false });
    expect(textOf(noConfirm)).toMatch(/confirm/);
    const d = await H().call('delete_trigger', {
      control_id: newId,
      dry_run: false,
      confirm: true,
    });
    expect(d.isError).toBeFalsy();
    expect(trpc.triggers.has(newId)).toBe(false);
    expect(trpc.triggers.has(id)).toBe(true);
  });
});

describe('update_button feedback style', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
  });

  it('sets, replaces in place and removes style overrides on a feedback', async () => {
    trpc.addButton(1, 0, 0);
    await H().call('update_button', {
      ...low,
      operations: [{ op: 'add_feedback', connection_id: 'conn1', feedback_id: 'tally' }],
      dry_run: false,
    });
    const fb = trpc.controls.get('ctl1')?.feedbacks[0];
    const fbId = fb?.id ?? '';
    await cooldown();
    const r = await H().call('update_button', {
      ...low,
      operations: [
        { op: 'set_feedback_style', entity_id: fbId, bgcolor: '#ff0000', color: '#ffffff' },
      ],
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(fb?.styleOverrides).toEqual([
      expect.objectContaining({
        elementId: 'box0',
        elementProperty: 'color',
        override: { value: 0xff0000, isExpression: false },
      }),
      expect.objectContaining({
        elementId: 'text0',
        elementProperty: 'color',
        override: { value: 0xffffff, isExpression: false },
      }),
    ]);
    const firstId = fb?.styleOverrides?.[0]?.overrideId;

    await cooldown();
    await H().call('update_button', {
      ...low,
      operations: [{ op: 'set_feedback_style', entity_id: fbId, bgcolor: '#00ff00' }],
      dry_run: false,
    });
    expect(fb?.styleOverrides).toHaveLength(2);
    expect(fb?.styleOverrides?.[0]).toMatchObject({
      overrideId: firstId,
      override: { value: 0x00ff00 },
    });

    const g = await H().call('get_button', low);
    expect(g.structuredContent).toMatchObject({
      feedbacks: [{ id: fbId, styleOverrides: [{ overrideId: firstId }, {}] }],
      layers: [{ id: 'canvas' }, { id: 'box0' }, { id: 'text0' }],
    });

    await cooldown();
    const rm = await H().call('update_button', {
      ...low,
      operations: [
        { op: 'remove_feedback_style', entity_id: fbId, properties: ['bgcolor', 'text'] },
      ],
      dry_run: false,
    });
    expect(rm.structuredContent).toMatchObject({
      results: [{ op: 'remove_feedback_style', ok: true, notSet: ['text'] }],
    });
    expect(fb?.styleOverrides).toHaveLength(1);
    expect(fb?.styleOverrides?.[0]?.elementId).toBe('text0');
  }, 15_000);

  it('rejects a style op without any property and an unknown feedback', async () => {
    trpc.addButton(1, 0, 0);
    const empty = await H().call('update_button', {
      ...low,
      operations: [{ op: 'set_feedback_style', entity_id: 'abc' }],
      dry_run: false,
    });
    expect(empty.isError).toBe(true);
    expect(mutations()).toEqual([]);
    const ghost = await H().call('update_button', {
      ...low,
      operations: [{ op: 'set_feedback_style', entity_id: 'ghost', color: '#000000' }],
      dry_run: false,
    });
    expect(textOf(ghost)).toMatch(/0 of 1/);
    expect(mutations()).toEqual([]);
  });
});
