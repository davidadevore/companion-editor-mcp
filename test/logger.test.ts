import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlLogger, LOG_BACKUPS, MAX_LOG_BYTES, clip, sanitise } from '../src/logger.js';

describe('sanitise', () => {
  it('redacts secret-looking keys and truncates long strings', () => {
    const out = sanitise({
      token: 'abc',
      apiKey: 'x',
      name: 'a'.repeat(300),
      n: 1,
      b: true,
      z: null,
    });
    expect(out).toEqual({
      token: '[redacted]',
      apiKey: '[redacted]',
      name: 'a'.repeat(200) + '...',
      n: 1,
      b: true,
      z: null,
    });
  });
  it('limits depth and handles arrays, undefined and functions', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitise(deep))).toContain('[truncated]');
    expect(sanitise([1, 'x', undefined])).toEqual([1, 'x', null]);
    expect(sanitise(() => 1)).toBe('function');
  });
});

describe('JsonlLogger', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('writes one JSON line per entry', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const logger = new JsonlLogger(dir);
    logger.log({ tool: 'ping', args: { secret: 'x' }, outcome: 'ok', allowed: true });
    const lines = readFileSync(path.join(dir, 'companion-editor-mcp.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed.tool).toBe('ping');
    expect(parsed.args).toEqual({ secret: '[redacted]' });
    expect(typeof parsed.ts).toBe('string');
  });

  it('clips detail, redacts value args, and reports success', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const logger = new JsonlLogger(dir);
    expect(
      logger.log({
        tool: 'x',
        args: { value: 'secret-ish' },
        outcome: 'ok',
        allowed: true,
        detail: 'y'.repeat(500),
      }),
    ).toBe(true);
    const line = JSON.parse(readFileSync(path.join(dir, 'companion-editor-mcp.jsonl'), 'utf8')) as {
      args: { value: string };
      detail: string;
    };
    expect(line.args.value).toBe('[redacted]');
    expect(line.detail).toBe(clip('y'.repeat(500)));
    expect(line.detail.length).toBe(203);
  });

  it('returns false when the log cannot be written', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const logger = new JsonlLogger(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(logger.log({ tool: 'x', args: {}, outcome: 'ok', allowed: true })).toBe(false);
  });

  it('keeps numbered backups up to the limit', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const file = path.join(dir, 'companion-editor-mcp.jsonl');
    const logger = new JsonlLogger(dir);
    for (let i = 0; i < LOG_BACKUPS + 2; i++) {
      writeFileSync(file, `gen${String(i)}` + 'x'.repeat(MAX_LOG_BYTES));
      logger.log({ tool: 'ping', args: {}, outcome: 'ok', allowed: true });
    }
    expect(readFileSync(`${file}.1`, 'utf8').startsWith('gen6')).toBe(true);
    expect(readFileSync(`${file}.${String(LOG_BACKUPS)}`, 'utf8').startsWith('gen2')).toBe(true);
    expect(() => statSync(`${file}.${String(LOG_BACKUPS + 1)}`)).toThrow();
  });

  it('rotates when the file exceeds the cap', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmcp-'));
    dirs.push(dir);
    const file = path.join(dir, 'companion-editor-mcp.jsonl');
    writeFileSync(file, 'x'.repeat(MAX_LOG_BYTES));
    const logger = new JsonlLogger(dir);
    logger.log({ tool: 'ping', args: {}, outcome: 'ok', allowed: true });
    expect(statSync(file + '.1').size).toBe(MAX_LOG_BYTES);
    expect(statSync(file).size).toBeLessThan(1000);
  });
});
