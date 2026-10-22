import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly connection: string | undefined;
  readonly body: string;
}

export type MockMode =
  | 'normal'
  | 'hang'
  | 'garbage'
  | 'disabled'
  | 'reset'
  | 'server-error'
  | 'redirect'
  | 'huge'
  | 'empty404';

export class MockCompanion {
  readonly requests: SeenRequest[] = [];
  readonly customVariables = new Map<string, unknown>();
  readonly moduleVariables = new Map<string, unknown>();
  readonly buttons = new Set<string>();
  readonly steps = new Map<string, number>();
  readonly styles = new Map<string, Record<string, unknown>>();
  connections: unknown[] = [];
  rescanFails = false;
  mode: MockMode = 'normal';
  #server: Server | undefined;
  #url: URL | undefined;

  get url(): URL {
    if (this.#url === undefined) {
      throw new Error('mock not started');
    }
    return this.#url;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.#server.address() as AddressInfo;
    this.#url = new URL(`http://127.0.0.1:${String(addr.port)}`);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      this.requests.push({
        method: req.method ?? '',
        path,
        contentType: req.headers['content-type'],
        connection: req.headers.connection,
        body,
      });
      if (this.mode === 'hang') {
        return;
      }
      if (this.mode === 'disabled') {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (this.mode === 'garbage') {
        res.setHeader('content-type', 'application/json');
        res.end('{not json');
        return;
      }
      if (this.mode === 'reset') {
        req.socket.destroy();
        return;
      }
      if (this.mode === 'server-error') {
        res.statusCode = 500;
        res.end('fail');
        return;
      }
      if (this.mode === 'redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://127.0.0.1:1/api/x');
        res.end();
        return;
      }
      if (this.mode === 'huge') {
        res.setHeader('content-type', 'text/html');
        res.end('x'.repeat(300 * 1024));
        return;
      }
      if (this.mode === 'empty404') {
        res.statusCode = 404;
        res.end('');
        return;
      }
      this.#route(req.method ?? '', path, body, res);
    });
  }

  #send(res: ServerResponse, status: number, value: unknown): void {
    res.statusCode = status;
    if (typeof value === 'string') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(value);
    } else if (typeof value === 'number') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(String(value));
    } else {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    }
  }

  #route(method: string, path: string, body: string, res: ServerResponse): void {
    const url = new URL(path, 'http://x');
    const seg = url.pathname.split('/').filter((s) => s !== '');
    if (seg[0] !== 'api') {
      this.#send(res, 404, '');
      return;
    }
    if (method === 'POST' && seg[1] === 'location' && seg.length === 6) {
      const key = `${seg[2] ?? ''}/${seg[3] ?? ''}/${seg[4] ?? ''}`;
      const verb = seg[5] ?? '';
      if (!this.buttons.has(key)) {
        this.#send(res, 204, 'No control');
        return;
      }
      if (['press', 'down', 'up', 'rotate-left', 'rotate-right'].includes(verb)) {
        this.#send(res, 200, 'ok');
        return;
      }
      if (verb === 'step') {
        const step = Number(url.searchParams.get('step'));
        if (!Number.isInteger(step) || step < 1 || step > 3) {
          this.#send(res, 400, 'Bad step');
        } else {
          this.steps.set(key, step);
          this.#send(res, 200, 'ok');
        }
        return;
      }
      if (verb === 'style') {
        this.styles.set(key, JSON.parse(body) as Record<string, unknown>);
        this.#send(res, 200, 'ok');
        return;
      }
      this.#send(res, 404, '');
      return;
    }
    if (method === 'POST' && seg[1] === 'surfaces' && seg[2] === 'rescan' && seg.length === 3) {
      if (this.rescanFails) {
        this.#send(res, 500, 'fail');
      } else {
        this.#send(res, 200, 'ok');
      }
      return;
    }
    if (method === 'POST' && seg[1] === 'connections' && seg.length === 4) {
      const id = seg[2] ?? '';
      const verb = seg[3] ?? '';
      const conn = this.connections.find(
        (c) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === id,
      ) as { id: string; enabled: boolean } | undefined;
      if (conn === undefined) {
        this.#send(res, 404, { status: 404, message: 'Connection not found' });
        return;
      }
      if (verb === 'restart') {
        if (!conn.enabled) {
          this.#send(res, 409, {
            status: 409,
            message: 'Connection is inactive and cannot be restarted',
          });
        } else {
          this.#send(res, 200, { id, message: 'Restart triggered' });
        }
        return;
      }
      if (verb === 'enable' || verb === 'disable') {
        conn.enabled = verb === 'enable';
        this.#send(res, 200, { id, enabled: conn.enabled });
        return;
      }
      this.#send(res, 404, '');
      return;
    }
    if (seg[1] === 'custom-variable' && seg.length === 4 && seg[3] === 'value') {
      const name = seg[2] ?? '';
      if (method === 'GET') {
        if (!this.customVariables.has(name)) {
          this.#send(res, 404, 'Not found');
        } else {
          this.#send(res, 200, this.customVariables.get(name));
        }
        return;
      }
      if (method === 'POST') {
        if (body.trim() === '') {
          this.#send(res, 400, 'No value');
        } else if (!this.customVariables.has(name)) {
          this.#send(res, 404, 'Not found');
        } else {
          this.customVariables.set(name, body.trim());
          this.#send(res, 200, 'ok');
        }
        return;
      }
    }
    if (method === 'GET' && seg[1] === 'variable' && seg.length === 5 && seg[4] === 'value') {
      const key = `${seg[2] ?? ''}:${seg[3] ?? ''}`;
      if (!this.moduleVariables.has(key)) {
        this.#send(res, 404, 'Not found');
      } else {
        this.#send(res, 200, this.moduleVariables.get(key));
      }
      return;
    }
    if (method === 'GET' && seg[1] === 'connections' && seg.length === 2) {
      this.#send(res, 200, this.connections);
      return;
    }
    if (method === 'GET' && seg[1] === 'connections' && seg.length === 4 && seg[3] === 'status') {
      const found = this.connections.find(
        (c) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === seg[2],
      );
      if (found === undefined) {
        this.#send(res, 404, { status: 404, message: 'Connection not found' });
      } else {
        this.#send(res, 200, found);
      }
      return;
    }
    this.#send(res, 404, '');
  }
}
