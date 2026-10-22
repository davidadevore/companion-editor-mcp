import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  isPrivateHost,
  loadConfig,
  resolveSafePath,
  validateCompanionUrl,
} from '../src/config.js';

const base = 'C:/work/proj';

describe('isPrivateHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['localhost', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.50', true],
    ['8.8.8.8', false],
    ['[::1]', true],
    ['::1', true],
    ['[::ffff:a00:1]', true],
    ['[::ffff:10.0.0.1]', true],
    ['[::ffff:808:808]', false],
    ['[fd00::1]', true],
    ['[2001:db8::1]', false],
    ['example.com', false],
    ['companion.local', false],
  ])('%s -> %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe('validateCompanionUrl', () => {
  it('accepts a loopback url', () => {
    expect(validateCompanionUrl('http://127.0.0.1:8000', false).host).toBe('127.0.0.1:8000');
  });
  it('rejects public hosts unless allowRemote', () => {
    expect(() => validateCompanionUrl('http://8.8.8.8:8000', false)).toThrow(ConfigError);
    expect(validateCompanionUrl('http://8.8.8.8:8000', true).hostname).toBe('8.8.8.8');
  });
  it('rejects non http schemes, credentials, paths, queries', () => {
    expect(() => validateCompanionUrl('ftp://127.0.0.1', false)).toThrow(ConfigError);
    expect(() => validateCompanionUrl('http://user:pw@127.0.0.1', false)).toThrow(ConfigError);
    expect(() => validateCompanionUrl('http://127.0.0.1/api', false)).toThrow(ConfigError);
    expect(() => validateCompanionUrl('http://127.0.0.1/?x=1', false)).toThrow(ConfigError);
    expect(() => validateCompanionUrl('not a url', false)).toThrow(ConfigError);
  });
});

describe('resolveSafePath', () => {
  it('rejects traversal outside the base dir for relative paths', () => {
    expect(() => resolveSafePath('../../etc/allowlist.json', base, '.json')).toThrow(ConfigError);
  });
  it('rejects null bytes and wrong extension', () => {
    expect(() => resolveSafePath('a\0.json', base, '.json')).toThrow(ConfigError);
    expect(() => resolveSafePath('config/allowlist.txt', base, '.json')).toThrow(ConfigError);
  });
  it('accepts relative paths inside base and absolute paths', () => {
    expect(resolveSafePath('./config/allowlist.json', base, '.json')).toContain('allowlist.json');
    expect(resolveSafePath('/srv/x/allowlist.json', base, '.json')).toContain('allowlist.json');
  });
});

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const c = loadConfig({}, base);
    expect(c.allowWrites).toBe(false);
    expect(c.allowRemote).toBe(false);
    expect(c.timeoutMs).toBe(3000);
    expect(c.companionUrl.href).toBe('http://127.0.0.1:8000/');
  });
  it('treats an empty string as invalid rather than default', () => {
    expect(() => loadConfig({ COMPANION_URL: '' }, base)).toThrow(ConfigError);
  });
  it('fails closed on bad values', () => {
    expect(() => loadConfig({ COMPANION_ALLOW_WRITES: 'yes' }, base)).toThrow(ConfigError);
    expect(() => loadConfig({ COMPANION_TIMEOUT_MS: '5' }, base)).toThrow(ConfigError);
    expect(() => loadConfig({ COMPANION_TIMEOUT_MS: 'abc' }, base)).toThrow(ConfigError);
    expect(() => loadConfig({ COMPANION_URL: 'http://1.2.3.4' }, base)).toThrow(ConfigError);
  });
  it('reads explicit values', () => {
    const c = loadConfig(
      {
        COMPANION_ALLOW_WRITES: 'true',
        COMPANION_TIMEOUT_MS: '500',
        COMPANION_URL: 'http://10.0.0.5:8000',
      },
      base,
    );
    expect(c.allowWrites).toBe(true);
    expect(c.timeoutMs).toBe(500);
    expect(c.companionUrl.hostname).toBe('10.0.0.5');
  });
});
