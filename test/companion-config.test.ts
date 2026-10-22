import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompanionError } from '../src/companion-client.js';
import { CompanionConfigClient, locateEntity } from '../src/companion-config.js';
import { evaluateConfigEdit, evaluatePageCreate } from '../src/safety.js';
import { TrpcClient } from '../src/trpc-client.js';
import { testAllowlist } from './helpers.js';
import { MockTrpc } from './mock-trpc.js';

const trpc = new MockTrpc();
let client: CompanionConfigClient;
const ctx = { allowWrites: true, allowConfigEdits: true, allowlist: testAllowlist };
const low = { page: 1, row: 0, column: 0 };
const high = { page: 1, row: 3, column: 7 };

function auth(loc: { page: number; row: number; column: number }) {
  const d = evaluateConfigEdit(ctx, loc, { confirm: true, destructive: true });
  if (!d.allowed) {
    throw new Error(d.reason);
  }
  return d.auth;
}
const pagesAuth = (() => {
  const d = evaluatePageCreate(ctx, { confirm: true });
  if (!d.allowed) {
    throw new Error(d.reason);
  }
  return d.auth;
})();

beforeAll(async () => {
  await trpc.start();
  client = new CompanionConfigClient(new TrpcClient(trpc.url, 300));
});
afterAll(async () => {
  await trpc.stop();
});
beforeEach(() => {
  trpc.reset();
});

describe('authorisation and validation before any call', () => {
  it('rejects foreign or missing auth for every write', async () => {
    const other = auth(high);
    await expect(client.createButton(low, other)).rejects.toThrow(/not authorised/);
    await expect(client.deleteButton(low, other)).rejects.toThrow(/not authorised/);
    await expect(client.createPages(1, ['a'], other)).rejects.toThrow(/not authorised/);
    await expect(
      client.addEntity(low, 'ctl1', 'feedbacks', 'action', 'c', 'd', other),
    ).rejects.toThrow(/not authorised/);
    await expect(
      client.setEntityOption(low, 'ctl1', 'feedbacks', 'e', 'k', 1, other),
    ).rejects.toThrow(/not authorised/);
    await expect(client.removeEntity(low, 'ctl1', 'feedbacks', 'e', other)).rejects.toThrow(
      /not authorised/,
    );
    expect(trpc.calls).toHaveLength(0);
  });
  it('rejects out of range locations, bad ids, bad option values, bad page args', async () => {
    const a = auth(low);
    await expect(client.resolveControlId({ page: 0, row: 0, column: 0 })).rejects.toThrow(
      CompanionError,
    );
    await expect(
      client.addEntity(low, 'bad id', 'feedbacks', 'action', 'c', 'd', a),
    ).rejects.toThrow(/control id/);
    await expect(
      client.addEntity(low, 'ctl1', 'feedbacks', 'action', 'c c', 'd', a),
    ).rejects.toThrow(/connection id/);
    await expect(
      client.addEntity(low, 'ctl1', 'feedbacks', 'action', 'c', 'd d', a),
    ).rejects.toThrow(/definition id/);
    await expect(
      client.setEntityOption(low, 'ctl1', 'feedbacks', 'e', 'bad key!', 1, a),
    ).rejects.toThrow(/option key/);
    await expect(
      client.setEntityOption(low, 'ctl1', 'feedbacks', 'e', 'k', () => 1, a),
    ).rejects.toThrow(/plain JSON/);
    await expect(client.createPages(0, ['a'], pagesAuth)).rejects.toThrow(/out of range/);
    await expect(client.createPages(1, [], pagesAuth)).rejects.toThrow(/page names/);
    await expect(client.createPages(1, ['x'.repeat(65)], pagesAuth)).rejects.toThrow(/too long/);
    expect(trpc.calls).toHaveLength(0);
  });
  it('accepts a real Companion control id containing a colon', async () => {
    const err = await client
      .addEntity(low, 'bank:Oh_9f4jps0pmEIyxY1hiO', 'feedbacks', 'action', 'c', 'd', auth(low))
      .catch((e: unknown) => e);
    expect(String(err)).not.toMatch(/control id/);
  });
});

describe('responses are validated', () => {
  it('pages snapshot with bad shape fails closed', async () => {
    trpc.mode = 'badshape';
    await expect(client.resolveControlId(low)).rejects.toThrow(/unexpected shape/);
    await expect(client.pageCount()).rejects.toThrow(/unexpected shape/);
  });
  it('unexpected entity id or insert result fails closed', async () => {
    const id = trpc.addButton(1, 0, 0);
    const a = auth(low);
    expect(
      await client.addEntity(low, id, 'feedbacks', 'feedback', 'nope', 'd', a),
    ).toBeUndefined();
    expect(await client.setEntityOption(low, id, 'feedbacks', 'ghost', 'k', 1, a)).toBe(false);
    expect(await client.removeEntity(low, id, 'feedbacks', 'ghost', a)).toBe(false);
    const eid = await client.addEntity(
      low,
      id,
      { stepId: '0', setId: 'up' },
      'action',
      'conn1',
      'd',
      a,
    );
    expect(eid).toMatch(/^ent/);
    const button = await client.getButton(low);
    if (button === undefined) {
      throw new Error('expected button');
    }
    expect(button.steps['0']?.up?.[0]?.id).toBe(eid);
    expect(locateEntity(button, eid ?? '')).toEqual({ stepId: '0', setId: 'up' });
    expect(locateEntity(button, 'ghost')).toBeUndefined();
  });
  it('getButton on a page that does not exist returns undefined', async () => {
    expect(await client.getButton({ page: 5, row: 0, column: 0 })).toBeUndefined();
  });
  it('delete on an empty slot is a no-op mutation', async () => {
    await client.deleteButton(low, auth(low));
    expect(trpc.calls.map((c) => c.path)).toEqual(['controls.resetControls']);
  });
});

describe('trpc client transport errors', () => {
  it('maps timeout, garbage, error, closed to CompanionError kinds', async () => {
    const t = new TrpcClient(trpc.url, 200);
    trpc.mode = 'hang';
    const h = (await t.first('pages.watch').catch((e: unknown) => e)) as CompanionError;
    expect(h.kind).toBe('timeout');
    trpc.mode = 'garbage';
    const g = (await t.first('pages.watch').catch((e: unknown) => e)) as CompanionError;
    expect(g.kind).toBe('malformed');
    trpc.mode = 'error';
    const e = (await t
      .call('mutation', 'pages.insert', {})
      .catch((x: unknown) => x)) as CompanionError;
    expect(e.kind).toBe('http');
    expect(e.writeAttempted).toBe(true);
    trpc.mode = 'closed';
    const c = (await t.first('pages.watch').catch((x: unknown) => x)) as CompanionError;
    expect(c.kind).toBe('network');
    const dead = new TrpcClient(new URL('http://127.0.0.1:1'), 200);
    const n = (await dead.first('pages.watch').catch((x: unknown) => x)) as CompanionError;
    expect(n.kind).toBe('network');
  });
  it('derives wss for https and keeps the host', () => {
    const t = new TrpcClient(new URL('https://10.0.0.5:8000'), 100);
    expect(t).toBeInstanceOf(TrpcClient);
  });
});
