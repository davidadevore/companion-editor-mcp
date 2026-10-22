import { isIP } from 'node:net';
import path from 'node:path';
import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const envBool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const envSchema = z.object({
  COMPANION_URL: z.string().min(1).max(256).default('http://127.0.0.1:8000'),
  COMPANION_ALLOW_WRITES: envBool,
  COMPANION_ALLOW_CONFIG_EDITS: envBool,
  COMPANION_ALLOW_REMOTE: envBool,
  COMPANION_ALLOWLIST_PATH: z.string().min(1).max(1024).default('./config/allowlist.json'),
  COMPANION_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  COMPANION_LOG_DIR: z.string().min(1).max(1024).default('./logs'),
});

export interface Config {
  readonly companionUrl: URL;
  readonly allowWrites: boolean;
  readonly allowConfigEdits: boolean;
  readonly allowRemote: boolean;
  readonly allowlistPath: string;
  readonly timeoutMs: number;
  readonly logDir: string;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function pick(env: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function parsePrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) {
    return false;
  }
  if (a === 127 || a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

function mappedIpv4(h: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted?.[1] !== undefined) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return undefined;
}

function parsePrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1') {
    return true;
  }
  const mapped = mappedIpv4(h);
  if (mapped !== undefined) {
    return parsePrivateIpv4(mapped);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h);
}

export function isPrivateHost(hostname: string): boolean {
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare === 'localhost') {
    return true;
  }
  const family = isIP(bare);
  if (family === 4) {
    return parsePrivateIpv4(bare);
  }
  if (family === 6) {
    return parsePrivateIpv6(bare);
  }
  return false;
}

export function validateCompanionUrl(raw: string, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('COMPANION_URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('COMPANION_URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('COMPANION_URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError('COMPANION_URL must not contain a query string or fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError('COMPANION_URL must not contain a path');
  }
  if (!allowRemote && !isPrivateHost(url.hostname)) {
    throw new ConfigError(
      'COMPANION_URL must be loopback or a private range unless COMPANION_ALLOW_REMOTE=true',
    );
  }
  return url;
}

export function resolveSafePath(raw: string, baseDir: string, expectedExt: string | null): string {
  if (raw.includes('\0')) {
    throw new ConfigError('path contains a null byte');
  }
  const resolved = path.resolve(baseDir, raw);
  if (!path.isAbsolute(raw)) {
    const rel = path.relative(baseDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ConfigError('relative path must stay inside the working directory');
    }
  }
  if (expectedExt !== null && path.extname(resolved).toLowerCase() !== expectedExt) {
    throw new ConfigError(`path must end with ${expectedExt}`);
  }
  return resolved;
}

export function loadConfig(env: EnvSource = process.env, baseDir: string = process.cwd()): Config {
  const parsed = envSchema.safeParse(pick(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    companionUrl: validateCompanionUrl(e.COMPANION_URL, e.COMPANION_ALLOW_REMOTE),
    allowWrites: e.COMPANION_ALLOW_WRITES,
    allowConfigEdits: e.COMPANION_ALLOW_CONFIG_EDITS,
    allowRemote: e.COMPANION_ALLOW_REMOTE,
    allowlistPath: resolveSafePath(e.COMPANION_ALLOWLIST_PATH, baseDir, '.json'),
    timeoutMs: e.COMPANION_TIMEOUT_MS,
    logDir: resolveSafePath(e.COMPANION_LOG_DIR, baseDir, null),
  };
}
