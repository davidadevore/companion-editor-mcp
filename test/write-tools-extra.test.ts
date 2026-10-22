import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockCompanion } from './mock-companion.js';
import { startHarness, testAllowlist, textOf, type Harness } from './helpers.js';

const mock = new MockCompanion();
let h: Harness;

beforeAll(async () => {
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.mode = 'normal';
  mock.requests.length = 0;
  mock.buttons.clear();
  mock.steps.clear();
  mock.styles.clear();
  mock.rescanFails = false;
  mock.buttons.add('1/0/0');
  mock.buttons.add('1/3/7');
  mock.connections = [
    { id: 'abc', label: 'OBS', moduleId: 'obs', enabled: true, status: { category: 'good' } },
    { id: 'off', label: 'Idle', moduleId: 'x', enabled: false },
  ];
});
afterEach(async () => {
  await h.close();
});

const posts = (): string[] => mock.requests.filter((r) => r.method === 'POST').map((r) => r.path);

describe('all write tools are listed', () => {
  it('exposes the full documented HTTP surface', async () => {
    h = await startHarness(mock);
    const names = (await h.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'button_action',
      'clone_trigger',
      'connection_action',
      'create_button',
      'create_page',
      'create_trigger',
      'delete_button',
      'delete_trigger',
      'get_button',
      'get_connection_status',
      'get_custom_variable',
      'get_module_variable',
      'get_trigger',
      'list_allowlist',
      'list_connections',
      'list_triggers',
      'ping',
      'press_button',
      'rescan_surfaces',
      'set_button_step',
      'set_button_style',
      'set_custom_variable',
      'update_button',
      'update_trigger',
    ]);
  });
});

describe('with writes disabled, every write tool refuses and sends nothing', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: false });
  });
  it.each([
    ['button_action', { page: 1, row: 0, column: 0, action: 'down', dry_run: false }],
    ['set_button_step', { page: 1, row: 0, column: 0, step: 2, dry_run: false }],
    ['set_button_style', { page: 1, row: 0, column: 0, text: 'x', dry_run: false }],
    ['connection_action', { id: 'abc', action: 'restart', dry_run: false, confirm: true }],
    ['rescan_surfaces', { dry_run: false }],
  ])('%s', async (tool, args) => {
    const r = await h.call(tool, args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/writes are disabled/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('button_action', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });
  it('dry run by default', async () => {
    const r = await h.call('button_action', { page: 1, row: 0, column: 0, action: 'rotate_left' });
    expect(textOf(r)).toMatch(/DRY RUN.*rotate-left/);
    expect(mock.requests).toHaveLength(0);
  });
  it('down then up on the same button are separate limiter keys', async () => {
    const d = await h.call('button_action', {
      page: 1,
      row: 0,
      column: 0,
      action: 'down',
      dry_run: false,
    });
    expect(d.isError).toBeFalsy();
    const u = await h.call('button_action', {
      page: 1,
      row: 0,
      column: 0,
      action: 'up',
      dry_run: false,
    });
    expect(u.isError).toBeFalsy();
    expect(posts()).toEqual(['/api/location/1/0/0/down', '/api/location/1/0/0/up']);
  });
  it('refuses off-allowlist and high risk without confirm, rejects bad action', async () => {
    const off = await h.call('button_action', {
      page: 5,
      row: 0,
      column: 0,
      action: 'down',
      dry_run: false,
    });
    expect(textOf(off)).toMatch(/not on the allowlist/);
    const hi = await h.call('button_action', {
      page: 1,
      row: 3,
      column: 7,
      action: 'up',
      dry_run: false,
    });
    expect(textOf(hi)).toMatch(/requires confirm/);
    const bad = await h.call('button_action', {
      page: 1,
      row: 0,
      column: 0,
      action: 'explode',
      dry_run: false,
    });
    expect(bad.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });
  it('reports stale allowlist on 204', async () => {
    mock.buttons.delete('1/0/0');
    const r = await h.call('button_action', {
      page: 1,
      row: 0,
      column: 0,
      action: 'down',
      dry_run: false,
    });
    expect(textOf(r)).toMatch(/no button/);
  });
});

describe('set_button_step', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });
  it('sets a step via query string', async () => {
    const r = await h.call('set_button_step', {
      page: 1,
      row: 0,
      column: 0,
      step: 2,
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(posts()).toEqual(['/api/location/1/0/0/step?step=2']);
    expect(mock.steps.get('1/0/0')).toBe(2);
  });
  it('surfaces Bad step as an error', async () => {
    const r = await h.call('set_button_step', {
      page: 1,
      row: 0,
      column: 0,
      step: 9,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Bad step/);
  });
  it('rejects out of range step at the schema', async () => {
    const r = await h.call('set_button_step', {
      page: 1,
      row: 0,
      column: 0,
      step: 0,
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('set_button_style', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });
  it('sends only the given fields as JSON', async () => {
    const r = await h.call('set_button_style', {
      page: 1,
      row: 0,
      column: 0,
      text: 'LIVE',
      bgcolor: '#ff0000',
      size: 'auto',
      dry_run: false,
    });
    expect(r.isError).toBeFalsy();
    expect(mock.styles.get('1/0/0')).toEqual({ text: 'LIVE', bgcolor: '#ff0000', size: 'auto' });
    expect(mock.requests[0]?.contentType).toBe('application/json');
  });
  it('rejects no fields, bad colour, bad size, long text', async () => {
    const none = await h.call('set_button_style', { page: 1, row: 0, column: 0, dry_run: false });
    expect(none.isError).toBe(true);
    const col = await h.call('set_button_style', {
      page: 1,
      row: 0,
      column: 0,
      color: 'red',
      dry_run: false,
    });
    expect(col.isError).toBe(true);
    const size = await h.call('set_button_style', {
      page: 1,
      row: 0,
      column: 0,
      size: 200,
      dry_run: false,
    });
    expect(size.isError).toBe(true);
    const long = await h.call('set_button_style', {
      page: 1,
      row: 0,
      column: 0,
      text: 'x'.repeat(201),
      dry_run: false,
    });
    expect(long.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });
  it('dry run shows the style', async () => {
    const r = await h.call('set_button_style', { page: 1, row: 0, column: 0, text: 'x' });
    expect(textOf(r)).toMatch(/DRY RUN.*"text":"x"/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('connection_action', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });
  it('always needs confirm, and the id must be allowlisted', async () => {
    const noConfirm = await h.call('connection_action', {
      id: 'abc',
      action: 'restart',
      dry_run: false,
    });
    expect(textOf(noConfirm)).toMatch(/require confirm/);
    const notListed = await h.call('connection_action', {
      id: 'off',
      action: 'restart',
      dry_run: false,
      confirm: true,
    });
    expect(textOf(notListed)).toMatch(/not on the allowlist/);
    expect(mock.requests).toHaveLength(0);
  });
  it('dry run by default even with confirm', async () => {
    const r = await h.call('connection_action', { id: 'abc', action: 'disable', confirm: true });
    expect(textOf(r)).toMatch(/DRY RUN/);
    expect(mock.requests).toHaveLength(0);
  });
  it('restart, disable, enable round trip', async () => {
    const restart = await h.call('connection_action', {
      id: 'abc',
      action: 'restart',
      dry_run: false,
      confirm: true,
    });
    expect(restart.structuredContent).toMatchObject({ result: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const disable = await h.call('connection_action', {
      id: 'abc',
      action: 'disable',
      dry_run: false,
      confirm: true,
    });
    expect(disable.structuredContent).toMatchObject({ result: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const again = await h.call('connection_action', {
      id: 'abc',
      action: 'restart',
      dry_run: false,
      confirm: true,
    });
    expect(textOf(again)).toMatch(/inactive/);
    expect(posts()).toEqual([
      '/api/connections/abc/restart',
      '/api/connections/abc/disable',
      '/api/connections/abc/restart',
    ]);
  });
  it('reports a stale allowlist when Companion has no such connection', async () => {
    mock.connections = [];
    const r = await h.call('connection_action', {
      id: 'abc',
      action: 'enable',
      dry_run: false,
      confirm: true,
    });
    expect(textOf(r)).toMatch(/does not exist/);
  });
});

describe('rescan_surfaces', () => {
  it('refuses when not enabled in the allowlist', async () => {
    h = await startHarness(mock, {
      allowWrites: true,
      allowlist: { ...testAllowlist, surfaces_rescan: false },
    });
    const r = await h.call('rescan_surfaces', { dry_run: false });
    expect(textOf(r)).toMatch(/not enabled in the allowlist/);
    expect(mock.requests).toHaveLength(0);
  });
  it('dry run default, then real, then failure surfaced', async () => {
    h = await startHarness(mock, { allowWrites: true });
    const dry = await h.call('rescan_surfaces');
    expect(textOf(dry)).toMatch(/DRY RUN/);
    const real = await h.call('rescan_surfaces', { dry_run: false });
    expect(real.isError).toBeFalsy();
    expect(posts()).toEqual(['/api/surfaces/rescan']);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    mock.rescanFails = true;
    const fail = await h.call('rescan_surfaces', { dry_run: false });
    expect(fail.isError).toBe(true);
    expect(textOf(fail)).toMatch(/rescan failed/);
  });
});
