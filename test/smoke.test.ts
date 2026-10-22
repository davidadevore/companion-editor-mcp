import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockCompanion } from './mock-companion.js';
import { textOf } from './helpers.js';

const dist = path.resolve(__dirname, '../dist/index.js');
const describeIfBuilt = existsSync(dist) ? describe : describe.skip;

describeIfBuilt('end to end over stdio against built dist', () => {
  const mock = new MockCompanion();
  let dir: string;
  let client: Client;
  let transport: StdioClientTransport;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  beforeAll(async () => {
    await mock.start();
    mock.buttons.add('1/0/0');
    mock.buttons.add('1/3/7');
    mock.customVariables.set('cue', 'intro');
    mock.connections = [
      { id: 'abc', label: 'OBS', moduleId: 'obs', enabled: true, status: { category: 'good' } },
    ];
    dir = mkdtempSync(path.join(tmpdir(), 'cmcp-smoke-'));
    writeFileSync(
      path.join(dir, 'allowlist.json'),
      JSON.stringify({
        buttons: [
          { page: 1, row: 0, column: 0, label: 'Cam 1', risk: 'low' },
          { page: 1, row: 3, column: 7, label: 'STREAM STOP', risk: 'high' },
        ],
        variables: ['cue'],
      }),
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      env: {
        ...(process.env as Record<string, string>),
        COMPANION_URL: mock.url.origin,
        COMPANION_ALLOW_WRITES: 'true',
        COMPANION_ALLOWLIST_PATH: path.join(dir, 'allowlist.json'),
        COMPANION_LOG_DIR: path.join(dir, 'logs'),
        COMPANION_TIMEOUT_MS: '500',
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client.close();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the manual test script steps', async () => {
    expect((await client.listTools()).tools).toHaveLength(24);

    const ping = await call('ping');
    expect(ping.structuredContent).toMatchObject({ ok: true, writesEnabled: true });

    expect((await call('get_custom_variable', { name: 'cue' })).structuredContent).toMatchObject({
      value: 'intro',
    });
    expect(
      (await call('get_custom_variable', { name: 'does_not_exist' })).structuredContent,
    ).toMatchObject({ found: false });

    expect(textOf(await call('list_connections'))).toContain('OBS [abc]');
    expect((await call('get_connection_status', { id: 'abc' })).structuredContent).toMatchObject({
      found: true,
    });
    expect(textOf(await call('list_allowlist'))).toContain('STREAM STOP');

    const dry = await call('press_button', { page: 1, row: 0, column: 0 });
    expect(textOf(dry)).toMatch(/DRY RUN/);
    expect(mock.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    const real = await call('press_button', { page: 1, row: 0, column: 0, dry_run: false });
    expect(real.isError).toBeFalsy();
    expect(textOf(real)).toMatch(/pressed "Cam 1"/);

    const noConfirm = await call('press_button', { page: 1, row: 3, column: 7, dry_run: false });
    expect(textOf(noConfirm)).toMatch(/requires confirm/);
    const confirmed = await call('press_button', {
      page: 1,
      row: 3,
      column: 7,
      dry_run: false,
      confirm: true,
    });
    expect(textOf(confirmed)).toMatch(/pressed "STREAM STOP"/);

    const off = await call('press_button', { page: 2, row: 0, column: 0, dry_run: false });
    expect(textOf(off)).toMatch(/not on the allowlist/);

    const set = await call('set_custom_variable', { name: 'cue', value: 'test', dry_run: false });
    expect(set.isError).toBeFalsy();
    expect((await call('get_custom_variable', { name: 'cue' })).structuredContent).toMatchObject({
      value: 'test',
    });

    expect(mock.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      '/api/location/1/0/0/press',
      '/api/location/1/3/7/press',
      '/api/custom-variable/cue/value',
    ]);

    const log = readFileSync(path.join(dir, 'logs', 'companion-editor-mcp.jsonl'), 'utf8');
    const lines = log.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(14);
    expect(log).toContain('"outcome":"attempt"');
    expect(log).toContain('"outcome":"refused"');
    expect(log).not.toContain('intro');
  }, 20_000);
});
