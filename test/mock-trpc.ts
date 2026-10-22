/**
 * Mock of the slice of Companion's tRPC WebSocket API that companion-config.ts uses.
 * Behaviour follows Companion 5.1.0 (see companion-config.ts header): resetControls takes a
 * list of locations, entity options are stored as sent, triggers keep `actions` and
 * `condition`, feedbacks carry style overrides.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

interface Entity {
  id: string;
  type: 'action' | 'feedback';
  connectionId: string;
  definitionId: string;
  options: Record<string, unknown>;
  isInverted?: unknown;
  styleOverrides?: {
    overrideId: string;
    elementId: string;
    elementProperty: string;
    override: unknown;
  }[];
}

interface TriggerEvent {
  id: string;
  type: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

interface Trigger {
  type: 'trigger';
  options: { name: string; enabled: boolean; sortOrder: number };
  actions: Entity[];
  condition: Entity[];
  events: TriggerEvent[];
  localVariables: unknown[];
}

interface Control {
  type: string;
  feedbacks: Entity[];
  steps: Record<
    string,
    { action_sets: Record<string, Entity[]>; options: Record<string, unknown> }
  >;
  options: Record<string, unknown>;
  style: { layers: { id: string; type: string; name: string }[] };
}

interface Page {
  id: string;
  name: string;
  controls: Record<string, Record<string, string>>;
}

export interface TrpcCall {
  readonly method: string;
  readonly path: string;
  readonly input: unknown;
}

export type TrpcMockMode = 'normal' | 'hang' | 'garbage' | 'error' | 'badshape' | 'closed';

export class MockTrpc {
  readonly calls: TrpcCall[] = [];
  readonly pages: Page[] = [];
  readonly controls = new Map<string, Control>();
  readonly triggers = new Map<string, Trigger>();
  readonly knownEventTypes = new Set<string>([
    'interval',
    'startup',
    'variable_changed',
    'condition_true',
  ]);
  readonly knownConnections = new Set<string>(['conn1']);
  mode: TrpcMockMode = 'normal';
  #http: Server | undefined;
  #wss: WebSocketServer | undefined;
  #url: URL | undefined;
  #nextId = 1;

  get url(): URL {
    if (this.#url === undefined) {
      throw new Error('mock not started');
    }
    return this.#url;
  }

  reset(): void {
    this.calls.length = 0;
    this.pages.length = 0;
    this.controls.clear();
    this.triggers.clear();
    this.mode = 'normal';
    this.#nextId = 1;
    this.pages.push({ id: 'p1', name: 'Page 1', controls: {} });
  }

  addButton(page: number, row: number, column: number): string {
    const id = `ctl${String(this.#nextId++)}`;
    const p = this.pages[page - 1];
    if (p === undefined) {
      throw new Error('no page');
    }
    const rowMap = p.controls[String(row)] ?? {};
    rowMap[String(column)] = id;
    p.controls[String(row)] = rowMap;
    this.controls.set(id, {
      type: 'button-layered',
      feedbacks: [],
      steps: { '0': { action_sets: { down: [], up: [] }, options: {} } },
      options: { stepProgression: 'auto', rotaryActions: false, canModifyStyleInApis: true },
      style: {
        layers: [
          { id: 'canvas', type: 'canvas', name: 'Canvas' },
          { id: 'box0', type: 'box', name: 'Background' },
          { id: 'text0', type: 'text', name: 'Text' },
        ],
      },
    });
    return id;
  }

  addTrigger(name: string, enabled = false): string {
    const id = `trigger:t${String(this.#nextId++)}`;
    this.triggers.set(id, {
      type: 'trigger',
      options: { name, enabled, sortOrder: this.triggers.size },
      actions: [],
      condition: [],
      events: [],
      localVariables: [],
    });
    return id;
  }

  async start(): Promise<void> {
    this.reset();
    this.#http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    this.#wss = new WebSocketServer({ server: this.#http, path: '/trpc' });
    this.#wss.on('connection', (ws) => {
      this.#serve(ws);
    });
    await new Promise<void>((resolve) => {
      this.#http?.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.#http.address() as AddressInfo;
    this.#url = new URL(`http://127.0.0.1:${String(addr.port)}`);
  }

  async stop(): Promise<void> {
    this.#wss?.clients.forEach((c) => {
      c.terminate();
    });
    await new Promise<void>((resolve) => {
      this.#wss?.close(() => {
        resolve();
      });
    });
    this.#http?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#http?.close(() => {
        resolve();
      });
    });
  }

  #serve(ws: WebSocket): void {
    if (this.mode === 'closed') {
      ws.close();
      return;
    }
    ws.on('message', (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.concat(raw as Buffer[]).toString('utf8');
      const msg = JSON.parse(text) as {
        id: number;
        method: string;
        params?: { path: string; input?: unknown };
      };
      if (msg.method === 'subscription.stop') {
        return;
      }
      const path = msg.params?.path ?? '';
      const input = msg.params?.input;
      this.calls.push({ method: msg.method, path, input });
      if (this.mode === 'hang') {
        return;
      }
      if (this.mode === 'garbage') {
        ws.send('{nope');
        return;
      }
      if (this.mode === 'error') {
        ws.send(JSON.stringify({ id: msg.id, error: { message: 'boom', code: -32603 } }));
        return;
      }
      const reply = (data: unknown): void => {
        if (msg.method === 'subscription') {
          ws.send(JSON.stringify({ id: msg.id, result: { type: 'started' } }));
        }
        ws.send(JSON.stringify({ id: msg.id, result: { type: 'data', data } }));
      };
      if (this.mode === 'badshape') {
        reply({ type: 'init', surprise: true });
        return;
      }
      let data: unknown;
      try {
        data = this.#route(path, input);
      } catch (err) {
        // Companion answers a throwing procedure with a tRPC error envelope.
        ws.send(
          JSON.stringify({
            id: msg.id,
            error: { message: err instanceof Error ? err.message : 'error', code: -32603 },
          }),
        );
        return;
      }
      reply(data);
    });
  }

  #locate(loc: { pageNumber: number; row: number; column: number }): {
    page: Page | undefined;
    id: string | undefined;
  } {
    const page = this.pages[loc.pageNumber - 1];
    const id = page?.controls[String(loc.row)]?.[String(loc.column)];
    return { page, id };
  }

  #entityList(control: Control | Trigger, where: unknown): Entity[] | undefined {
    if (control.type === 'trigger') {
      const t = control as Trigger;
      if (where === 'feedbacks') {
        return t.condition;
      }
      return where === 'trigger_actions' ? t.actions : undefined;
    }
    const c = control as Control;
    if (where === 'feedbacks') {
      return c.feedbacks;
    }
    if (typeof where === 'object' && where !== null) {
      const w = where as { stepId: string; setId: string };
      const step = c.steps[w.stepId];
      if (step === undefined) {
        return undefined;
      }
      step.action_sets[w.setId] ??= [];
      return step.action_sets[w.setId];
    }
    return undefined;
  }

  #anyControl(id: unknown): Control | Trigger | undefined {
    return this.controls.get(String(id)) ?? this.triggers.get(String(id));
  }

  #route(path: string, input: unknown): unknown {
    const i = input as Record<string, unknown>;
    switch (path) {
      case 'pages.watch':
        return {
          type: 'init',
          order: this.pages.map((p) => p.id),
          pages: Object.fromEntries(
            this.pages.map((p) => [p.id, { name: p.name, controls: p.controls }]),
          ),
        };
      case 'controls.watchControl': {
        const c = this.#anyControl(i.controlId);
        if (c === undefined) {
          throw new Error('Control not found');
        }
        return { type: 'init', config: c, runtime: {} };
      }
      case 'controls.resetControls': {
        for (const loc of i.locations as { pageNumber: number; row: number; column: number }[]) {
          const { page, id } = this.#locate(loc);
          if (page === undefined) {
            continue;
          }
          if (id !== undefined) {
            this.controls.delete(id);
            delete page.controls[String(loc.row)]?.[String(loc.column)];
          }
          if (i.newType === 'button-layered') {
            this.addButton(loc.pageNumber, loc.row, loc.column);
          }
        }
        return undefined;
      }
      case 'controls.triggers.watch':
        return {
          type: 'init',
          triggers: Object.fromEntries(
            [...this.triggers.entries()].map(([id, t]) => [
              id,
              {
                type: 'trigger',
                name: t.options.name,
                enabled: t.options.enabled,
                sortOrder: t.options.sortOrder,
                lastExecuted: null,
                description: t.events.map((e) => e.type).join(', '),
                collectionEnabled: true,
                isRateLimited: false,
              },
            ]),
          ),
        };
      case 'controls.triggers.create':
        return this.addTrigger('New Trigger');
      case 'controls.triggers.clone': {
        const src = this.triggers.get(String(i.controlId));
        if (src === undefined) {
          throw new Error('Trigger not found');
        }
        const id = this.addTrigger(src.options.name, src.options.enabled);
        const copy = this.triggers.get(id);
        if (copy !== undefined) {
          copy.events = structuredClone(src.events);
          copy.actions = structuredClone(src.actions);
          copy.condition = structuredClone(src.condition);
        }
        return id;
      }
      case 'controls.triggers.delete':
        return this.triggers.delete(String(i.controlId));
      case 'controls.setOptionsField': {
        const t = this.triggers.get(String(i.controlId));
        if (t === undefined || (i.key !== 'name' && i.key !== 'enabled')) {
          return false;
        }
        if (i.key === 'name') {
          t.options.name = String(i.value);
        } else {
          t.options.enabled = i.value === true;
        }
        return true;
      }
      case 'controls.events.add': {
        const t = this.triggers.get(String(i.controlId));
        if (t === undefined || !this.knownEventTypes.has(String(i.eventType))) {
          return false;
        }
        t.events.push({
          id: `ev${String(this.#nextId++)}`,
          type: String(i.eventType),
          enabled: true,
          options: {},
        });
        return true;
      }
      case 'controls.events.setOption': {
        const e = this.triggers.get(String(i.controlId))?.events.find((x) => x.id === i.eventId);
        if (e === undefined) {
          return false;
        }
        e.options[String(i.key)] = i.value;
        return true;
      }
      case 'controls.events.remove': {
        const t = this.triggers.get(String(i.controlId));
        const idx = t?.events.findIndex((x) => x.id === i.eventId) ?? -1;
        if (t === undefined || idx < 0) {
          return false;
        }
        t.events.splice(idx, 1);
        return true;
      }
      case 'controls.entities.setInverted': {
        const c = this.#anyControl(i.controlId);
        const e =
          c === undefined
            ? undefined
            : this.#entityList(c, i.entityLocation)?.find((x) => x.id === i.entityId);
        if (e === undefined) {
          return false;
        }
        e.isInverted = i.isInverted;
        return true;
      }
      case 'controls.entities.replaceStyleOverride': {
        const c = this.#anyControl(i.controlId);
        const e =
          c === undefined
            ? undefined
            : this.#entityList(c, i.entityLocation)?.find((x) => x.id === i.entityId);
        if (e?.type !== 'feedback') {
          return false;
        }
        const o = i.override as NonNullable<Entity['styleOverrides']>[number];
        e.styleOverrides ??= [];
        const at = e.styleOverrides.findIndex((x) => x.overrideId === o.overrideId);
        if (at >= 0) {
          e.styleOverrides[at] = o;
        } else {
          e.styleOverrides.push(o);
        }
        return true;
      }
      case 'controls.entities.removeStyleOverride': {
        const c = this.#anyControl(i.controlId);
        const e =
          c === undefined
            ? undefined
            : this.#entityList(c, i.entityLocation)?.find((x) => x.id === i.entityId);
        const at = e?.styleOverrides?.findIndex((x) => x.overrideId === i.overrideId) ?? -1;
        if (e === undefined || at < 0) {
          return false;
        }
        e.styleOverrides?.splice(at, 1);
        return true;
      }
      case 'pages.insert': {
        const names = i.pageNames as string[];
        const at = Number(i.asPageNumber);
        const fresh = names.map((name) => ({
          id: `p${String(this.#nextId++)}`,
          name,
          controls: {},
        }));
        this.pages.splice(at - 1, 0, ...fresh);
        return 'ok';
      }
      case 'controls.entities.add': {
        const c = this.#anyControl(i.controlId);
        if (c === undefined || !this.knownConnections.has(String(i.connectionId))) {
          return null;
        }
        const list = this.#entityList(c, i.entityLocation);
        if (list === undefined) {
          return null;
        }
        const e: Entity = {
          id: `ent${String(this.#nextId++)}`,
          type: i.entityType as 'action' | 'feedback',
          connectionId: String(i.connectionId),
          definitionId: String(i.entityDefinition),
          options: {},
        };
        list.push(e);
        return e.id;
      }
      case 'controls.entities.setOption': {
        const c = this.#anyControl(i.controlId);
        const list = c === undefined ? undefined : this.#entityList(c, i.entityLocation);
        const e = list?.find((x) => x.id === i.entityId);
        if (e === undefined) {
          return false;
        }
        e.options[String(i.key)] = i.value;
        return true;
      }
      case 'controls.entities.remove': {
        const c = this.#anyControl(i.controlId);
        const list = c === undefined ? undefined : this.#entityList(c, i.entityLocation);
        if (list === undefined) {
          return false;
        }
        const idx = list.findIndex((x) => x.id === i.entityId);
        if (idx < 0) {
          return false;
        }
        list.splice(idx, 1);
        return true;
      }
      default:
        throw new Error(`unknown path ${path}`);
    }
  }
}
