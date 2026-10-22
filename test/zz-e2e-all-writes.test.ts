import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockCompanion } from './mock-companion.js';
import { textOf } from './helpers.js';

const dist = path.resolve(__dirname, '../dist/index.js');
const describeIfBuilt = existsSync(dist) ? describe : describe.skip;

describeIfBuilt('every write tool end to end over stdio against built dist', () => {
  it('sends each documented HTTP command exactly once', async () => {
    const mock = new MockCompanion();
    await mock.start();
    mock.buttons.add('1/0/0');
    mock.customVariables.set('cue', 'a');
    mock.connections = [{ id: 'abc', label: 'OBS', moduleId: 'obs', enabled: true }];
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify({
        buttons: [{ page: 1, row: 0, column: 0, label: 'B', risk: 'low' }],
        variables: ['cue'],
        connections: ['abc'],
        surfaces_rescan: true,
      }),
    );
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      env: {
        ...(process.env as Record<string, string>),
        COMPANION_URL: mock.url.origin,
        COMPANION_ALLOW_WRITES: 'true',
        COMPANION_ALLOWLIST_PATH: path.join(dir, 'a.json'),
        COMPANION_LOG_DIR: path.join(dir, 'logs'),
        COMPANION_TIMEOUT_MS: '500',
      },
      stderr: 'pipe',
    });
    const c = new Client({ name: 's', version: '0' });
    await c.connect(t);
    const call = async (name: string, a: Record<string, unknown>): Promise<CallToolResult> =>
      (await c.callTool({ name, arguments: a })) as CallToolResult;
    const results = [
      await call('press_button', { page: 1, row: 0, column: 0, dry_run: false }),
      await call('button_action', { page: 1, row: 0, column: 0, action: 'down', dry_run: false }),
      await call('button_action', { page: 1, row: 0, column: 0, action: 'up', dry_run: false }),
      await call('set_button_step', { page: 1, row: 0, column: 0, step: 2, dry_run: false }),
      await call('set_button_style', {
        page: 1,
        row: 0,
        column: 0,
        text: 'LIVE',
        bgcolor: '#ff0000',
        dry_run: false,
      }),
      await call('set_custom_variable', { name: 'cue', value: 'b', dry_run: false }),
      await call('connection_action', {
        id: 'abc',
        action: 'restart',
        dry_run: false,
        confirm: true,
      }),
      await call('rescan_surfaces', { dry_run: false }),
    ];
    const allowlist = await call('list_allowlist', {});
    await c.close();
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const r of results) {
      expect(r.isError, textOf(r)).toBeFalsy();
    }
    expect(textOf(allowlist)).toContain('surface rescan enabled');
    expect(mock.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      '/api/location/1/0/0/press',
      '/api/location/1/0/0/down',
      '/api/location/1/0/0/up',
      '/api/location/1/0/0/step?step=2',
      '/api/location/1/0/0/style',
      '/api/custom-variable/cue/value',
      '/api/connections/abc/restart',
      '/api/surfaces/rescan',
    ]);
  }, 30_000);
});
