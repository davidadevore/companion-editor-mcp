import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUPS = 5;
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const SECRET_KEY_RE = /(token|secret|password|passwd|key|auth|credential|cookie|^value$)/i;

export interface LogEntry {
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: 'ok' | 'error' | 'refused' | 'attempt';
  readonly allowed: boolean;
  readonly dryRun?: boolean;
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface Logger {
  /** Returns false if the entry could not be persisted. Callers gating writes must check it. */
  log(entry: LogEntry): boolean;
}

export function clip(text: string, max = MAX_STRING): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

export function sanitise(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return clip(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((v) => sanitise(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitise(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

function prepare(entry: LogEntry): LogEntry {
  return {
    ...entry,
    args: sanitise(entry.args),
    ...(entry.detail === undefined ? {} : { detail: clip(entry.detail) }),
  };
}

export class JsonlLogger implements Logger {
  readonly #file: string;

  constructor(dir: string, fileName = 'companion-editor-mcp.jsonl') {
    mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, fileName);
  }

  #rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.#file).size;
    } catch {
      return;
    }
    if (size < MAX_LOG_BYTES) {
      return;
    }
    for (let i = LOG_BACKUPS - 1; i >= 1; i--) {
      const from = `${this.#file}.${String(i)}`;
      if (existsSync(from)) {
        renameSync(from, `${this.#file}.${String(i + 1)}`);
      }
    }
    renameSync(this.#file, this.#file + '.1');
  }

  log(entry: LogEntry): boolean {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...prepare(entry) });
    try {
      this.#rotateIfNeeded();
      appendFileSync(this.#file, line + '\n', { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      process.stderr.write('companion-editor-mcp: failed to write log\n');
      return false;
    }
  }
}

export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];
  healthy = true;

  log(entry: LogEntry): boolean {
    if (!this.healthy) {
      return false;
    }
    this.entries.push(prepare(entry));
    return true;
  }
}
