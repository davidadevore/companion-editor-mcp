import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockTrpc } from './mock-trpc.js';
import { textOf } from './helpers.js';

const dist = path.resolve(__dirname, '../dist/index.js');
const describeIfBuilt = existsSync(dist) ? describe : describe.skip;

describeIfBuilt('config-edit tools end to end over stdio against built dist', () => {
  it('walks the verification script against the tRPC mock', async () => {
    const trpc = new MockTrpc();
    await trpc.start();
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    writeFileSync(
      path.join(dir, 'a.json'),
      JSON.stringify({
        buttons: [{ page: 1, row: 3, column: 7, label: 'Sacrificial', risk: 'low' }],
        pages_create: true,
      }),
    );
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [dist],
      env: {
        ...(process.env as Record<string, string>),
        COMPANION_URL: trpc.url.origin,
        COMPANION_ALLOW_WRITES: 'true',
        COMPANION_ALLOW_CONFIG_EDITS: 'true',
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
    const loc = { page: 1, row: 3, column: 7 };
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 2100));

    const ping = await call('ping', {});
    expect(textOf(ping)).toMatch(/Config edits ENABLED/);

    expect((await call('get_button', loc)).structuredContent).toMatchObject({ found: false });

    const created = await call('create_button', { ...loc, dry_run: false, confirm: true });
    expect(created.isError, textOf(created)).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ controlId: 'ctl1' });
    await pause();

    const added = await call('update_button', {
      ...loc,
      operations: [
        { op: 'add_action', connection_id: 'conn1', action_id: 'program', options: { input: 1 } },
      ],
      dry_run: false,
    });
    expect(added.isError, textOf(added)).toBeFalsy();
    const entityId = (added.structuredContent as { results: { entityId: string }[] }).results[0]
      ?.entityId;
    expect(entityId).toMatch(/^ent/);
    await pause();

    const got = await call('get_button', loc);
    expect(got.structuredContent).toMatchObject({
      found: true,
      steps: {
        '0': {
          down: [
            {
              id: entityId,
              definitionId: 'program',
              options: { input: { value: 1, isExpression: false } },
            },
          ],
        },
      },
    });

    const edited = await call('update_button', {
      ...loc,
      operations: [
        { op: 'set_options', entity_id: entityId, options: { input: 2 } },
        { op: 'remove_entity', entity_id: entityId },
      ],
      dry_run: false,
      confirm: true,
    });
    expect(edited.isError, textOf(edited)).toBeFalsy();
    expect(textOf(edited)).toMatch(/2 of 2/);
    await pause();

    const deleted = await call('delete_button', { ...loc, dry_run: false, confirm: true });
    expect(deleted.isError, textOf(deleted)).toBeFalsy();
    expect(trpc.controls.size).toBe(0);

    const page = await call('create_page', {
      as_page_number: 2,
      names: ['Test'],
      dry_run: false,
      confirm: true,
    });
    expect(page.isError, textOf(page)).toBeFalsy();
    expect(page.structuredContent).toMatchObject({ totalPages: 2 });

    await c.close();
    await trpc.stop();
    rmSync(dir, { recursive: true, force: true });

    expect(trpc.calls.filter((x) => x.method === 'mutation').map((x) => x.path)).toEqual([
      'controls.resetControls',
      'controls.entities.add',
      'controls.entities.setOption',
      'controls.entities.setOption',
      'controls.entities.remove',
      'controls.resetControls',
      'pages.insert',
    ]);
  }, 40_000);
});
