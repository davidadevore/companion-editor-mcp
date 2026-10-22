import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(__dirname, '../src');

function readAll(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of readAll(full)) {
        out.set(k, v);
      }
    } else if (entry.name.endsWith('.ts')) {
      out.set(path.relative(srcDir, full).replaceAll('\\', '/'), readFileSync(full, 'utf8'));
    }
  }
  return out;
}

const files = readAll(srcDir);

describe('structural invariants', () => {
  it('only companion-client.ts performs HTTP requests and only trpc-client.ts opens sockets', () => {
    for (const [name, text] of files) {
      if (name !== 'companion-client.ts') {
        expect(text, name).not.toMatch(/\bfetch\s*\(/);
        expect(text, name).not.toMatch(/node:http/);
      }
      if (name !== 'trpc-client.ts') {
        expect(text, name).not.toMatch(/new WebSocket\(/);
      }
    }
  });

  const configWriteMethods = [
    'createButton',
    'deleteButton',
    'createPages',
    'addEntity',
    'setEntityOption',
    'removeEntity',
    'replaceStyleOverride',
    'removeStyleOverride',
  ];

  const triggerWriteMethods = [
    'createTrigger',
    'cloneTrigger',
    'deleteTrigger',
    'setTriggerOption',
    'addTriggerEvent',
    'setTriggerEventOption',
    'removeTriggerEvent',
    'addTriggerEntity',
    'setTriggerEntityOption',
    'setTriggerConditionInverted',
    'removeTriggerEntity',
  ];

  it('trigger write methods are only called from trigger-tools inside performWrite after a decision', () => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixed list of method names
    const re = new RegExp(`\\.(${triggerWriteMethods.join('|')})\\(`);
    const callers = [...files.entries()].filter(
      ([name, text]) => name !== 'companion-config.ts' && re.test(text),
    );
    expect(callers.map(([n]) => n)).toEqual(['tools/trigger-tools.ts']);
    const text = files.get('tools/trigger-tools.ts') ?? '';
    for (const m of triggerWriteMethods) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- fixed list of method names
      for (const hit of text.matchAll(new RegExp(`\\.${m}\\(`, 'g'))) {
        const before = text.slice(0, hit.index);
        expect(before.lastIndexOf('performWrite('), m).toBeGreaterThan(
          before.lastIndexOf('registerTool('),
        );
        expect(before.lastIndexOf('if (!decision.allowed)'), m).toBeGreaterThan(
          before.lastIndexOf('registerTool('),
        );
      }
    }
    const cfg = files.get('companion-config.ts') ?? '';
    for (const m of triggerWriteMethods) {
      const idx = cfg.indexOf(`async ${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const bodyStart = cfg.indexOf('{', cfg.indexOf(')', idx));
      expect(cfg.slice(bodyStart, bodyStart + 400), m).toMatch(/requireTriggerAuth\(/);
    }
  });

  it('config write methods are only called from config-tools inside performWrite after a decision', () => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixed list of method names
    const re = new RegExp(`\\.(${configWriteMethods.join('|')})\\(`);
    const callers = [...files.entries()].filter(
      ([name, text]) => name !== 'companion-config.ts' && re.test(text),
    );
    expect(callers.map(([n]) => n)).toEqual(['tools/config-tools.ts']);
    const text = files.get('tools/config-tools.ts') ?? '';
    for (const m of configWriteMethods) {
      const idx = text.indexOf(`.${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const before = text.slice(0, idx);
      expect(before.lastIndexOf('performWrite('), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
      expect(before.lastIndexOf('if (!decision.allowed)'), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
    }
    const cfg = files.get('companion-config.ts') ?? '';
    for (const m of configWriteMethods) {
      const idx = cfg.indexOf(`async ${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const bodyStart = cfg.indexOf('{', cfg.indexOf(')', idx));
      expect(cfg.slice(bodyStart, bodyStart + 400), m).toMatch(
        /requireButtonAuth\(|coversPages\(\)/,
      );
    }
  });

  it('tRPC mutations are only issued from companion-config.ts', () => {
    for (const [name, text] of files) {
      if (name !== 'companion-config.ts' && name !== 'trpc-client.ts') {
        expect(text, name).not.toMatch(/'mutation'/);
      }
    }
  });

  const writeMethods = [
    'pressButton',
    'buttonAction',
    'setButtonStep',
    'setButtonStyle',
    'setCustomVariable',
    'connectionAction',
    'rescanSurfaces',
  ];

  it('client write methods are only called from write-tools, each inside performWrite', () => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixed list of method names
    const re = new RegExp(`\\.(${writeMethods.join('|')})\\(`);
    const callers = [...files.entries()].filter(
      ([name, text]) => name !== 'companion-client.ts' && re.test(text),
    );
    expect(callers.map(([n]) => n)).toEqual(['tools/write-tools.ts']);
    const text = files.get('tools/write-tools.ts') ?? '';
    for (const m of writeMethods) {
      const idx = text.indexOf(`.${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const before = text.slice(0, idx);
      expect(before.lastIndexOf('performWrite('), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
      expect(before.lastIndexOf('if (!decision.allowed)'), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
    }
  });

  it('every client write method requires a WriteAuthorisation', () => {
    const text = files.get('companion-client.ts') ?? '';
    for (const m of writeMethods) {
      if (m === 'pressButton') {
        continue;
      }
      const idx = text.indexOf(`async ${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const bodyStart = text.indexOf('{', text.indexOf(')', idx));
      const head = text.slice(bodyStart, bodyStart + 400);
      expect(head, m).toMatch(/requireAuth\(/);
    }
  });

  it('safety decisions check both allowlist and write gate', () => {
    const text = files.get('safety.ts') ?? '';
    expect(text).toMatch(/isWriteEnabled\(ctx\)/);
    expect(text).toMatch(/getButtonEntry\(ctx\.allowlist/);
    expect(text).toMatch(/isVariableAllowed\(ctx\.allowlist/);
  });

  it('no retry logic exists', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/retr(y|ies)/i);
    }
  });

  it('no legacy Companion endpoints are referenced', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/press\/bank|style\/bank|set\/custom-variable|['"`]\/rescan/);
    }
  });

  it('no dashes other than hyphens', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
