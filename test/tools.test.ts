import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockCompanion } from './mock-companion.js';
import { startHarness, textOf, type Harness } from './helpers.js';

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
  mock.customVariables.clear();
  mock.moduleVariables.clear();
  mock.buttons.clear();
  mock.connections = [];
  mock.buttons.add('1/0/0');
  mock.buttons.add('1/3/7');
  mock.customVariables.set('cue', 'intro');
});
afterEach(async () => {
  await h.close();
});

describe('read tools', () => {
  beforeEach(async () => {
    h = await startHarness(mock);
  });

  it('lists all tools', async () => {
    const tools = await h.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
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

  it('ping reports write state and makes no request', async () => {
    const r = await h.call('ping');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: true, writesEnabled: false });
    expect(mock.requests).toHaveLength(0);
  });

  it('get_custom_variable returns value and logs without the value', async () => {
    const r = await h.call('get_custom_variable', { name: 'cue' });
    expect(r.structuredContent).toEqual({ name: 'cue', found: true, value: 'intro' });
    expect(textOf(r)).toBe('custom:cue = intro');
    expect(h.logger.entries[0]).toMatchObject({
      tool: 'get_custom_variable',
      outcome: 'ok',
      detail: 'custom:cue found',
    });
    expect(JSON.stringify(h.logger.entries)).not.toContain('intro');
  });

  it('get_custom_variable reports not found', async () => {
    const r = await h.call('get_custom_variable', { name: 'nope' });
    expect(r.structuredContent).toEqual({ name: 'nope', found: false });
  });

  it('rejects unknown keys and bad names at the schema', async () => {
    const r1 = await h.call('get_custom_variable', { name: 'cue', extra: 1 });
    expect(r1.isError).toBe(true);
    const r2 = await h.call('get_custom_variable', { name: 'a/b' });
    expect(r2.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('get_module_variable', async () => {
    mock.moduleVariables.set('atem:program', 'Cam 2');
    const r = await h.call('get_module_variable', { connection_label: 'atem', name: 'program' });
    expect(r.structuredContent).toMatchObject({ found: true, value: 'Cam 2' });
    const miss = await h.call('get_module_variable', { connection_label: 'atem', name: 'x' });
    expect(miss.structuredContent).toMatchObject({ found: false });
  });

  it('list_connections and get_connection_status', async () => {
    mock.connections = [
      {
        id: 'abc',
        label: 'OBS',
        moduleId: 'obs',
        enabled: true,
        status: { category: 'good', message: 'Connected' },
      },
    ];
    const list = await h.call('list_connections');
    expect(textOf(list)).toContain('OBS [abc] obs enabled good: Connected');
    const st = await h.call('get_connection_status', { id: 'abc' });
    expect(st.structuredContent).toMatchObject({ found: true });
    const miss = await h.call('get_connection_status', { id: 'zzz' });
    expect(miss.structuredContent).toEqual({ id: 'zzz', found: false });
    mock.connections = [];
    expect(textOf(await h.call('list_connections'))).toBe('no connections configured');
  });

  it('list_allowlist exposes buttons and variables', async () => {
    const r = await h.call('list_allowlist');
    expect(textOf(r)).toContain('1/3/7 "STREAM STOP" risk=high');
    expect(textOf(r)).toContain('variables: cue');
    expect(mock.requests).toHaveLength(0);
  });

  it('errors are safe: timeout, malformed, disabled api, down', async () => {
    mock.mode = 'hang';
    const t = await h.call('get_custom_variable', { name: 'cue' });
    expect(t.isError).toBe(true);
    expect(textOf(t)).toMatch(/Outcome unknown/);
    mock.mode = 'garbage';
    const g = await h.call('get_custom_variable', { name: 'cue' });
    expect(textOf(g)).toMatch(/malformed/);
    mock.mode = 'disabled';
    const d = await h.call('get_custom_variable', { name: 'cue' });
    expect(textOf(d)).toMatch(/disabled/);
    expect(h.logger.entries.filter((e) => e.outcome === 'error')).toHaveLength(3);
    for (const e of h.logger.entries) {
      expect(JSON.stringify(e)).not.toMatch(/at .*\.ts:/);
    }
  });
});

describe('press_button with writes disabled', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: false });
  });

  it('refuses even when allowlisted and dry_run false', async () => {
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/writes are disabled/);
    expect(mock.requests).toHaveLength(0);
    expect(h.logger.entries[0]).toMatchObject({ outcome: 'refused', allowed: false });
  });

  it('set_custom_variable refused', async () => {
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'x', dry_run: false });
    expect(textOf(r)).toMatch(/writes are disabled/);
    expect(mock.requests).toHaveLength(0);
    expect(mock.customVariables.get('cue')).toBe('intro');
  });
});

describe('press_button with writes enabled', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });

  it('dry run is the default and sends nothing', async () => {
    const r = await h.call('press_button', { page: 1, row: 0, column: 0 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/DRY RUN.*Cam 1/);
    expect(r.structuredContent).toMatchObject({ dryRun: true, sent: false, label: 'Cam 1' });
    expect(mock.requests).toHaveLength(0);
    expect(h.logger.entries[0]).toMatchObject({ dryRun: true, outcome: 'ok' });
  });

  it('refuses locations not on the allowlist', async () => {
    const r = await h.call('press_button', {
      page: 2,
      row: 0,
      column: 0,
      dry_run: false,
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not on the allowlist/);
    expect(mock.requests).toHaveLength(0);
  });

  it('refuses high risk without confirm', async () => {
    const r = await h.call('press_button', { page: 1, row: 3, column: 7, dry_run: false });
    expect(textOf(r)).toMatch(/requires confirm/);
    expect(mock.requests).toHaveLength(0);
  });

  it('presses a low risk button with dry_run false', async () => {
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ sent: true, result: 'ok', label: 'Cam 1' });
    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/location/1/0/0/press' }),
    ]);
  });

  it('presses a high risk button with confirm', async () => {
    const r = await h.call('press_button', {
      page: 1,
      row: 3,
      column: 7,
      dry_run: false,
      confirm: true,
    });
    expect(r.structuredContent).toMatchObject({ sent: true, result: 'ok', label: 'STREAM STOP' });
  });

  it('reports a stale allowlist when Companion has no control there', async () => {
    mock.buttons.delete('1/0/0');
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(textOf(r)).toMatch(/no button/);
    expect(r.structuredContent).toMatchObject({ result: 'no_control' });
  });

  it('on timeout reports unknown outcome and sends exactly one request', async () => {
    mock.mode = 'hang';
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Outcome unknown/);
    expect(mock.requests).toHaveLength(1);
    expect(h.logger.entries.map((e) => e.outcome)).toEqual(['attempt', 'error']);
  });

  it('on connection reset or 5xx after a press reports unknown outcome', async () => {
    mock.mode = 'reset';
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(textOf(r)).toMatch(/Outcome unknown/);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    mock.mode = 'server-error';
    const s = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(textOf(s)).toMatch(/500.*Outcome unknown/);
  });

  it('logs an attempt line before the press and refuses if the log is unhealthy', async () => {
    const ok = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(ok.isError).toBeFalsy();
    expect(h.logger.entries.map((e) => e.outcome)).toEqual(['attempt', 'ok']);
    h.logger.healthy = false;
    const r = await h.call('press_button', {
      page: 1,
      row: 3,
      column: 7,
      dry_run: false,
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/audit log is not writable/);
    expect(mock.requests).toHaveLength(1);
  });

  it('blocks a rapid second press of the same button and parallel presses', async () => {
    const first = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(first.isError).toBeFalsy();
    const second = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/wait \d+ms/);
    expect(mock.requests).toHaveLength(1);
    mock.mode = 'hang';
    const [a, b] = await Promise.all([
      h.call('press_button', { page: 1, row: 3, column: 7, dry_run: false, confirm: true }),
      h.call('press_button', { page: 1, row: 3, column: 7, dry_run: false, confirm: true }),
    ]);
    const texts = [textOf(a), textOf(b)];
    expect(texts.filter((t) => t.includes('in flight'))).toHaveLength(1);
    expect(mock.requests).toHaveLength(2);
  });

  it('reports api disabled and companion down', async () => {
    mock.mode = 'disabled';
    const d = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(textOf(d)).toMatch(/disabled \(403\)/);
    await h.close();
    const down = new MockCompanion();
    await down.start();
    await down.stop();
    h = await startHarness(down, { allowWrites: true });
    const r = await h.call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(textOf(r)).toMatch(/could not reach/);
  });

  it('rejects unknown keys and out of range values', async () => {
    const r1 = await h.call('press_button', {
      page: 1,
      row: 0,
      column: 0,
      dry_run: false,
      nuke: true,
    });
    expect(r1.isError).toBe(true);
    const r2 = await h.call('press_button', { page: 0, row: 0, column: 0, dry_run: false });
    expect(r2.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('set_custom_variable with writes enabled', () => {
  beforeEach(async () => {
    h = await startHarness(mock, { allowWrites: true });
  });

  it('dry run default sends nothing', async () => {
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'main' });
    expect(textOf(r)).toMatch(/DRY RUN/);
    expect(mock.requests).toHaveLength(0);
  });

  it('refuses names not on the allowlist', async () => {
    const r = await h.call('set_custom_variable', { name: 'other', value: 'x', dry_run: false });
    expect(textOf(r)).toMatch(/not on the allowlist/);
    expect(mock.requests).toHaveLength(0);
  });

  it('writes with dry_run false', async () => {
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'main', dry_run: false });
    expect(r.structuredContent).toMatchObject({ sent: true, result: 'ok' });
    expect(mock.customVariables.get('cue')).toBe('main');
  });

  it('reports not found when Companion lacks the variable', async () => {
    mock.customVariables.delete('cue');
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'main', dry_run: false });
    expect(r.structuredContent).toMatchObject({ result: 'not_found' });
  });

  it('on timeout reports unknown outcome, one request', async () => {
    mock.mode = 'hang';
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'main', dry_run: false });
    expect(textOf(r)).toMatch(/Outcome unknown/);
    expect(mock.requests).toHaveLength(1);
  });

  it('rejects over-long and blank values', async () => {
    const r = await h.call('set_custom_variable', {
      name: 'cue',
      value: 'x'.repeat(1001),
      dry_run: false,
    });
    expect(r.isError).toBe(true);
    const b = await h.call('set_custom_variable', { name: 'cue', value: '   ', dry_run: false });
    expect(b.isError).toBe(true);
    expect(mock.requests).toHaveLength(0);
  });

  it('never logs the value', async () => {
    await h.call('set_custom_variable', { name: 'cue', value: 'top-secret-cue', dry_run: false });
    expect(JSON.stringify(h.logger.entries)).not.toContain('top-secret-cue');
  });

  it('cooldown applies per variable', async () => {
    await h.call('set_custom_variable', { name: 'cue', value: 'a', dry_run: false });
    const r = await h.call('set_custom_variable', { name: 'cue', value: 'b', dry_run: false });
    expect(textOf(r)).toMatch(/wait/);
    expect(mock.customVariables.get('cue')).toBe('a');
  });
});
