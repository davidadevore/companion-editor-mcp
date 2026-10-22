import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WriteAuthorisation } from '../src/authorisation.js';
import {
  AllowlistError,
  WriteLimiter,
  evaluateConnectionAction,
  evaluateSurfacesRescan,
  isConnectionAllowed,
  evaluatePress,
  evaluateSetVariable,
  getButtonEntry,
  isButtonAllowed,
  isVariableAllowed,
  isWriteEnabled,
  loadAllowlist,
  locationKey,
  parseAllowlist,
} from '../src/safety.js';
import { testAllowlist } from './helpers.js';

const valid = JSON.stringify({
  buttons: [{ page: 1, row: 0, column: 0, label: 'Cam 1', risk: 'low' }],
  variables: ['cue'],
});

describe('parseAllowlist', () => {
  it('parses a valid file and defaults variables, connections and rescan to closed', () => {
    const a = parseAllowlist(JSON.stringify({ buttons: [] }));
    expect(a.buttons).toEqual([]);
    expect(a.variables).toEqual([]);
    expect(a.connections).toEqual([]);
    expect(a.surfaces_rescan).toBe(false);
    expect(a.pages_create).toBe(false);
  });
  it('rejects bad connection ids, duplicates, and non-boolean rescan', () => {
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], connections: ['a b'] }))).toThrow(
      AllowlistError,
    );
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], connections: ['a', 'a'] }))).toThrow(
      /duplicate connection/,
    );
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], surfaces_rescan: 'yes' }))).toThrow(
      AllowlistError,
    );
  });
  it('rejects malformed JSON', () => {
    expect(() => parseAllowlist('{nope')).toThrow(AllowlistError);
  });
  it('rejects unknown keys, bad ranges, bad risk, bad variable names', () => {
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], extra: 1 }))).toThrow(AllowlistError);
    expect(() =>
      parseAllowlist(
        JSON.stringify({ buttons: [{ page: 0, row: 0, column: 0, label: 'x', risk: 'low' }] }),
      ),
    ).toThrow(AllowlistError);
    expect(() =>
      parseAllowlist(
        JSON.stringify({ buttons: [{ page: 1, row: 99, column: 0, label: 'x', risk: 'low' }] }),
      ),
    ).toThrow(AllowlistError);
    expect(() =>
      parseAllowlist(
        JSON.stringify({ buttons: [{ page: 1, row: 0, column: 0, label: 'x', risk: 'medium' }] }),
      ),
    ).toThrow(AllowlistError);
    expect(() =>
      parseAllowlist(
        JSON.stringify({ buttons: [{ page: 1.5, row: 0, column: 0, label: 'x', risk: 'low' }] }),
      ),
    ).toThrow(AllowlistError);
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], variables: ['bad name'] }))).toThrow(
      AllowlistError,
    );
  });
  it('rejects duplicate buttons and variables', () => {
    const b = { page: 1, row: 0, column: 0, label: 'x', risk: 'low' };
    expect(() => parseAllowlist(JSON.stringify({ buttons: [b, { ...b, label: 'y' }] }))).toThrow(
      /duplicate button/,
    );
    expect(() => parseAllowlist(JSON.stringify({ buttons: [], variables: ['a', 'a'] }))).toThrow(
      /duplicate variable/,
    );
  });
});

describe('loadAllowlist', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('fails closed when the file is missing', () => {
    expect(() => loadAllowlist('/definitely/not/here.json')).toThrow(AllowlistError);
  });
  it('fails closed when the file is malformed or too large', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '[1,2');
    expect(() => loadAllowlist(bad)).toThrow(AllowlistError);
    const big = path.join(dir, 'big.json');
    writeFileSync(big, '"' + 'x'.repeat(300 * 1024) + '"');
    expect(() => loadAllowlist(big)).toThrow(/too large/);
  });
  it('loads a valid file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const good = path.join(dir, 'good.json');
    writeFileSync(good, valid);
    expect(loadAllowlist(good).buttons).toHaveLength(1);
  });
});

describe('lookups', () => {
  it('finds entries and reports allowed state', () => {
    expect(getButtonEntry(testAllowlist, { page: 1, row: 0, column: 0 })?.label).toBe('Cam 1');
    expect(isButtonAllowed(testAllowlist, { page: 1, row: 0, column: 0 })).toBe(true);
    expect(isButtonAllowed(testAllowlist, { page: 2, row: 0, column: 0 })).toBe(false);
    expect(isVariableAllowed(testAllowlist, 'cue')).toBe(true);
    expect(isVariableAllowed(testAllowlist, 'other')).toBe(false);
    expect(isWriteEnabled({ allowWrites: true })).toBe(true);
    expect(isWriteEnabled({ allowWrites: false })).toBe(false);
    expect(locationKey({ page: 1, row: 2, column: 3 })).toBe('1/2/3');
  });
});

describe('evaluatePress', () => {
  const low = { page: 1, row: 0, column: 0 };
  const high = { page: 1, row: 3, column: 7 };
  it('refuses when not on allowlist, even with writes enabled', () => {
    const d = evaluatePress(
      { allowWrites: true, allowlist: testAllowlist },
      { page: 5, row: 0, column: 0 },
      { confirm: true },
    );
    expect(d).toMatchObject({ allowed: false });
    expect(d.allowed ? '' : d.reason).toMatch(/not on the allowlist/);
  });
  it('refuses when writes disabled', () => {
    const d = evaluatePress({ allowWrites: false, allowlist: testAllowlist }, low, {
      confirm: false,
    });
    expect(d.allowed ? '' : d.reason).toMatch(/writes are disabled/);
  });
  it('refuses high risk without confirm, allows with confirm', () => {
    const ctx = { allowWrites: true, allowlist: testAllowlist };
    expect(evaluatePress(ctx, high, { confirm: false }).allowed).toBe(false);
    const d = evaluatePress(ctx, high, { confirm: true });
    expect(d.allowed).toBe(true);
    expect(d.allowed ? d.entry.label : '').toBe('STREAM STOP');
    expect(d.allowed ? d.auth : null).toBeInstanceOf(WriteAuthorisation);
    expect(d.allowed && d.auth.coversButton(high)).toBe(true);
    expect(d.allowed && d.auth.coversButton(low)).toBe(false);
    expect(d.allowed && d.auth.coversVariable('cue')).toBe(false);
  });
  it('allows low risk without confirm', () => {
    expect(
      evaluatePress({ allowWrites: true, allowlist: testAllowlist }, low, { confirm: false })
        .allowed,
    ).toBe(true);
  });
});

describe('evaluateSetVariable', () => {
  it('refuses invalid names, non allowlisted names, and disabled writes', () => {
    const on = { allowWrites: true, allowlist: testAllowlist };
    expect(evaluateSetVariable(on, 'bad name').allowed).toBe(false);
    expect(evaluateSetVariable(on, 'other').allowed).toBe(false);
    expect(evaluateSetVariable({ ...on, allowWrites: false }, 'cue').allowed).toBe(false);
    const d = evaluateSetVariable(on, 'cue');
    expect(d).toMatchObject({ allowed: true, name: 'cue' });
    expect(d.allowed && d.auth.coversVariable('cue')).toBe(true);
    expect(d.allowed && d.auth.coversVariable('other')).toBe(false);
  });
});

describe('evaluateConnectionAction', () => {
  const on = { allowWrites: true, allowlist: testAllowlist };
  it('refuses invalid, unlisted, writes-off, and unconfirmed', () => {
    expect(evaluateConnectionAction(on, 'bad id', { confirm: true }).allowed).toBe(false);
    expect(evaluateConnectionAction(on, 'zzz', { confirm: true }).allowed).toBe(false);
    expect(
      evaluateConnectionAction({ ...on, allowWrites: false }, 'abc', { confirm: true }).allowed,
    ).toBe(false);
    const d = evaluateConnectionAction(on, 'abc', { confirm: false });
    expect(d.allowed ? '' : d.reason).toMatch(/require confirm/);
    expect(isConnectionAllowed(testAllowlist, 'abc')).toBe(true);
  });
  it('allows with confirm and mints a connection-scoped auth', () => {
    const d = evaluateConnectionAction(on, 'abc', { confirm: true });
    expect(d.allowed).toBe(true);
    expect(d.allowed && d.auth.coversConnection('abc')).toBe(true);
    expect(d.allowed && d.auth.coversConnection('other')).toBe(false);
    expect(d.allowed && d.auth.coversSurfaces()).toBe(false);
    expect(d.allowed && d.auth.coversButton({ page: 1, row: 0, column: 0 })).toBe(false);
  });
});

describe('evaluateSurfacesRescan', () => {
  it('needs allowlist flag and writes', () => {
    const closed = { ...testAllowlist, surfaces_rescan: false };
    expect(evaluateSurfacesRescan({ allowWrites: true, allowlist: closed }).allowed).toBe(false);
    expect(evaluateSurfacesRescan({ allowWrites: false, allowlist: testAllowlist }).allowed).toBe(
      false,
    );
    const d = evaluateSurfacesRescan({ allowWrites: true, allowlist: testAllowlist });
    expect(d.allowed && d.auth.coversSurfaces()).toBe(true);
    expect(d.allowed && d.auth.coversVariable('cue')).toBe(false);
  });
});

describe('WriteAuthorisation', () => {
  it('cannot be minted without the key', () => {
    expect(() => new WriteAuthorisation(Symbol('fake'), { kind: 'variable', name: 'cue' })).toThrow(
      /only be minted/,
    );
  });
});

describe('WriteLimiter', () => {
  it('blocks concurrent writes to the same key and enforces cooldown', () => {
    let now = 1000;
    const limiter = new WriteLimiter(2000, () => now);
    const first = limiter.acquire('a');
    expect(first.ok).toBe(true);
    expect(limiter.acquire('a')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/in flight/) as string,
    });
    expect(limiter.acquire('b').ok).toBe(true);
    if (first.ok) {
      first.release();
    }
    now = 1500;
    expect(limiter.acquire('a')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/wait 1500ms/) as string,
    });
    now = 3001;
    expect(limiter.acquire('a').ok).toBe(true);
  });
});
