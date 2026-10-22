import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockCompanion } from './mock-companion.js';
import { MockTrpc } from './mock-trpc.js';
import { startHarness, testAllowlist, textOf, type Harness } from './helpers.js';

const http = new MockCompanion();
const trpc = new MockTrpc();
let h: Harness;

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
  await h.close();
});

const low = { page: 1, row: 0, column: 0 };
const high = { page: 1, row: 3, column: 7 };
const mutations = (): string[] =>
  trpc.calls.filter((c) => c.method === 'mutation').map((c) => c.path);

describe('config tools refuse unless both flags are on', () => {
  it('writes on, config edits off: every config tool refuses, nothing reaches tRPC', async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: false, trpc });
    const calls: [string, Record<string, unknown>][] = [
      ['get_button', low],
      ['create_button', { ...low, dry_run: false, confirm: true }],
      ['delete_button', { ...low, dry_run: false, confirm: true }],
      [
        'update_button',
        {
          ...low,
          operations: [{ op: 'add_action', connection_id: 'conn1', action_id: 'x' }],
          dry_run: false,
        },
      ],
      ['create_page', { as_page_number: 2, names: ['New'], dry_run: false, confirm: true }],
    ];
    for (const [tool, args] of calls) {
      const r = await h.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(textOf(r), tool).toMatch(/CONFIG_EDITS|config edits/);
    }
    expect(trpc.calls).toHaveLength(0);
  });

  it('config edits on but writes off still refuses writes', async () => {
    h = await startHarness(http, { allowWrites: false, allowConfigEdits: true, trpc });
    const r = await h.call('create_button', { ...low, dry_run: false, confirm: true });
    expect(textOf(r)).toMatch(/config edits are disabled/);
    expect(trpc.calls).toHaveLength(0);
  });
});

describe('get_button', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
  });
  it('reports an empty slot and a configured button', async () => {
    const empty = await h.call('get_button', low);
    expect(empty.structuredContent).toMatchObject({ found: false });
    const id = trpc.addButton(1, 0, 0);
    const r = await h.call('get_button', low);
    expect(r.structuredContent).toMatchObject({
      found: true,
      controlId: id,
      type: 'button-layered',
    });
    expect(textOf(r)).toMatch(/0 actions, 0 feedbacks/);
    expect(JSON.stringify(h.logger.entries)).not.toContain('button-layered');
  });
  it('fails closed on an unexpected snapshot shape, error, garbage, hang, closed', async () => {
    trpc.addButton(1, 0, 0);
    for (const [mode, re] of [
      ['badshape', /unexpected shape/],
      ['error', /rejected pages.watch: boom/],
      ['garbage', /not JSON/],
      ['hang', /did not respond/],
      ['closed', /closed early|connection failed/],
    ] as const) {
      trpc.mode = mode;
      const r = await h.call('get_button', low);
      expect(r.isError, mode).toBe(true);
      expect(textOf(r), mode).toMatch(re);
    }
  });
  it('works for any page/row/column on the allowlist or not (read only)', async () => {
    const r = await h.call('get_button', { page: 1, row: 2, column: 2 });
    expect(r.structuredContent).toMatchObject({ found: false });
  });
});

describe('create_button and delete_button', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
  });
  it('always need confirm, dry run by default, allowlist enforced', async () => {
    const dry = await h.call('create_button', { ...low, confirm: true });
    expect(textOf(dry)).toMatch(/DRY RUN/);
    const noConfirm = await h.call('create_button', { ...low, dry_run: false });
    expect(textOf(noConfirm)).toMatch(/requires confirm/);
    const off = await h.call('create_button', {
      page: 2,
      row: 0,
      column: 0,
      dry_run: false,
      confirm: true,
    });
    expect(textOf(off)).toMatch(/not on the allowlist/);
    const delNoConfirm = await h.call('delete_button', { ...low, dry_run: false });
    expect(textOf(delNoConfirm)).toMatch(/requires confirm/);
    expect(mutations()).toEqual([]);
  });
  it('creates with newType button-layered, then deletes', async () => {
    const c = await h.call('create_button', { ...low, dry_run: false, confirm: true });
    expect(c.isError).toBeFalsy();
    expect(c.structuredContent).toMatchObject({ sent: true, controlId: 'ctl1' });
    expect(trpc.calls.find((x) => x.path === 'controls.resetControls')?.input).toEqual({
      locations: [{ pageNumber: 1, row: 0, column: 0 }],
      newType: 'button-layered',
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const d = await h.call('delete_button', { ...low, dry_run: false, confirm: true });
    expect(d.isError).toBeFalsy();
    expect(trpc.controls.size).toBe(0);
    expect(trpc.calls.filter((x) => x.path === 'controls.resetControls')[1]?.input).toEqual({
      locations: [{ pageNumber: 1, row: 0, column: 0 }],
      newType: null,
    });
    expect(h.logger.entries.filter((e) => e.outcome === 'attempt')).toHaveLength(2);
  });
  it('one attempt on a tRPC error, reported as unknown outcome', async () => {
    trpc.mode = 'error';
    const r = await h.call('create_button', { ...high, dry_run: false, confirm: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/boom.*Outcome unknown/);
    expect(mutations()).toEqual(['controls.resetControls']);
  });
});

describe('update_button', () => {
  beforeEach(async () => {
    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
    trpc.addButton(1, 0, 0);
  });
  it('adds an action with options, a feedback, updates options, removes', async () => {
    const r = await h.call('update_button', {
      ...low,
      operations: [
        { op: 'add_action', connection_id: 'conn1', action_id: 'program', options: { input: 1 } },
        { op: 'add_feedback', connection_id: 'conn1', feedback_id: 'tally', options: { input: 1 } },
      ],
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/2 of 2 operations applied/);
    const ctl = trpc.controls.get('ctl1');
    expect(ctl?.steps['0']?.action_sets.down).toHaveLength(1);
    expect(ctl?.steps['0']?.action_sets.down?.[0]?.options).toEqual({
      input: { value: 1, isExpression: false },
    });
    expect(ctl?.feedbacks).toHaveLength(1);
    const actionId = ctl?.steps['0']?.action_sets.down?.[0]?.id ?? '';
    const feedbackId = ctl?.feedbacks[0]?.id ?? '';
    expect(mutations()).toEqual([
      'controls.entities.add',
      'controls.entities.setOption',
      'controls.entities.add',
      'controls.entities.setOption',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 2100));
    const g = await h.call('get_button', low);
    expect(g.structuredContent).toMatchObject({
      steps: { '0': { down: [{ id: actionId, kind: 'action', definitionId: 'program' }] } },
      feedbacks: [{ id: feedbackId, kind: 'feedback' }],
    });

    const noConfirm = await h.call('update_button', {
      ...low,
      operations: [{ op: 'remove_entity', entity_id: actionId }],
      dry_run: false,
    });
    expect(textOf(noConfirm)).toMatch(/destructive.*requires confirm/);

    const r2 = await h.call('update_button', {
      ...low,
      operations: [
        { op: 'set_options', entity_id: feedbackId, options: { input: 2 } },
        { op: 'remove_entity', entity_id: actionId },
      ],
      dry_run: false,
      confirm: true,
    });
    expect(r2.isError).toBeFalsy();
    expect(ctl?.feedbacks[0]?.options).toEqual({ input: { value: 2, isExpression: false } });
    expect(ctl?.steps['0']?.action_sets.down).toHaveLength(0);
  });
  it('stops at the first failing operation and reports it', async () => {
    const r = await h.call('update_button', {
      ...low,
      operations: [
        { op: 'add_action', connection_id: 'nope', action_id: 'x' },
        { op: 'add_action', connection_id: 'conn1', action_id: 'y' },
      ],
      dry_run: false,
    });
    expect(textOf(r)).toMatch(/0 of 2 operations applied at 1\/0\/0, stopped/);
    expect(r.structuredContent).toMatchObject({
      results: [{ op: 'add_action', ok: false }],
    });
    expect(mutations()).toEqual(['controls.entities.add']);
  });
  it('unknown entity id, empty slot, bad op, dry run default', async () => {
    const unknown = await h.call('update_button', {
      ...low,
      operations: [{ op: 'set_options', entity_id: 'ghost', options: { a: 1 } }],
      dry_run: false,
    });
    expect(r2text(unknown)).toMatch(/0 of 1/);
    expect(unknown.structuredContent).toMatchObject({
      results: [{ ok: false, error: /not found/ }],
    });
    const bad = await h.call('update_button', {
      ...low,
      operations: [{ op: 'explode' }],
      dry_run: false,
    });
    expect(bad.isError).toBe(true);
    const dry = await h.call('update_button', {
      ...low,
      operations: [{ op: 'add_action', connection_id: 'conn1', action_id: 'y' }],
    });
    expect(textOf(dry)).toMatch(/DRY RUN.*add_action/);
    trpc.reset();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const empty = await h.call('update_button', {
      ...low,
      operations: [{ op: 'add_action', connection_id: 'conn1', action_id: 'y' }],
      dry_run: false,
    });
    expect(textOf(empty)).toMatch(/no button at 1\/0\/0/);
    expect(mutations()).toEqual([]);
  });
});

function r2text(r: Parameters<typeof textOf>[0]): string {
  return textOf(r);
}

describe('create_page', () => {
  it('needs pages_create, confirm, dry run default; inserts and reports total', async () => {
    h = await startHarness(http, {
      allowWrites: true,
      allowConfigEdits: true,
      trpc,
      allowlist: { ...testAllowlist, pages_create: false },
    });
    const off = await h.call('create_page', {
      as_page_number: 2,
      names: ['A'],
      dry_run: false,
      confirm: true,
    });
    expect(textOf(off)).toMatch(/pages_create/);
    await h.close();

    h = await startHarness(http, { allowWrites: true, allowConfigEdits: true, trpc });
    const noConfirm = await h.call('create_page', {
      as_page_number: 2,
      names: ['A'],
      dry_run: false,
    });
    expect(textOf(noConfirm)).toMatch(/requires confirm/);
    const dry = await h.call('create_page', { as_page_number: 2, names: ['A'], confirm: true });
    expect(textOf(dry)).toMatch(/DRY RUN/);
    expect(mutations()).toEqual([]);
    const r = await h.call('create_page', {
      as_page_number: 2,
      names: ['Cams', 'Audio'],
      dry_run: false,
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ totalPages: 3 });
    expect(trpc.pages.map((p) => p.name)).toEqual(['Page 1', 'Cams', 'Audio']);
    expect(trpc.calls.find((c) => c.path === 'pages.insert')?.input).toEqual({
      asPageNumber: 2,
      pageNames: ['Cams', 'Audio'],
    });
    const tooMany = await h.call('create_page', {
      as_page_number: 1,
      names: Array.from({ length: 11 }, () => 'x'),
      dry_run: false,
      confirm: true,
    });
    expect(tooMany.isError).toBe(true);
  });
});
