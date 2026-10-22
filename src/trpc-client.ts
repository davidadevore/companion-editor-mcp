/**
 * Minimal tRPC-over-WebSocket client for Companion's internal admin API (/trpc).
 *
 * This API is undocumented and unauthenticated. It is used only by the config-edit tools,
 * which are off unless COMPANION_ALLOW_CONFIG_EDITS=true. No third party dependency:
 * the tRPC v11 wire format is plain JSON and Node 22 ships a WebSocket client.
 *
 * One connection per call, like the HTTP client. Every response is validated by the
 * caller with zod; anything unexpected fails closed.
 */
import { CompanionError } from './companion-client.js';

export const TRPC_MAX_MESSAGE_BYTES = 1024 * 1024;

type TrpcMethod = 'query' | 'mutation' | 'subscription';

interface TrpcEnvelope {
  readonly id: number;
  readonly result?: { readonly type?: string; readonly data?: unknown };
  readonly error?: { readonly message?: string; readonly code?: number };
}

function parseEnvelope(raw: unknown): TrpcEnvelope | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (raw.length > TRPC_MAX_MESSAGE_BYTES) {
    throw new CompanionError('malformed', 'Companion tRPC message too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompanionError('malformed', 'Companion tRPC message was not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const env = parsed as TrpcEnvelope;
  return typeof env.id === 'number' ? env : undefined;
}

export class TrpcClient {
  readonly #wsUrl: string;
  readonly #timeoutMs: number;

  constructor(companionUrl: URL, timeoutMs: number) {
    const ws = new URL(companionUrl);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.pathname = '/trpc';
    this.#wsUrl = ws.toString();
    this.#timeoutMs = timeoutMs;
  }

  /** Query or mutation: returns the single data payload. */
  async call(method: 'query' | 'mutation', path: string, input?: unknown): Promise<unknown> {
    return this.#roundTrip(method, path, input, false);
  }

  /** Subscription: returns the first data payload (Companion sends an "init" snapshot first). */
  async first(path: string, input?: unknown): Promise<unknown> {
    return this.#roundTrip('subscription', path, input, true);
  }

  #roundTrip(method: TrpcMethod, path: string, input: unknown, isSub: boolean): Promise<unknown> {
    const writeAttempted = method === 'mutation';
    return new Promise<unknown>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.#wsUrl);
      } catch {
        reject(new CompanionError('network', 'could not open a WebSocket to Companion'));
        return;
      }
      const id = 1;
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (isSub && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id, method: 'subscription.stop' }));
        }
        try {
          socket.close();
        } catch {
          // already closed
        }
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          reject(
            new CompanionError(
              'timeout',
              `Companion tRPC did not respond within ${String(this.#timeoutMs)}ms`,
              { writeAttempted },
            ),
          );
        });
      }, this.#timeoutMs);

      socket.addEventListener('open', () => {
        const params = input === undefined ? { path } : { path, input };
        socket.send(JSON.stringify({ id, method, params }));
      });
      socket.addEventListener('error', () => {
        finish(() => {
          reject(
            new CompanionError('network', 'Companion tRPC connection failed', { writeAttempted }),
          );
        });
      });
      socket.addEventListener('close', () => {
        finish(() => {
          reject(
            new CompanionError('network', 'Companion tRPC connection closed early', {
              writeAttempted,
            }),
          );
        });
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        let env: TrpcEnvelope | undefined;
        try {
          env = parseEnvelope(event.data);
        } catch (err) {
          finish(() => {
            reject(err instanceof Error ? err : new CompanionError('malformed', 'bad message'));
          });
          return;
        }
        if (env?.id !== id) {
          return;
        }
        if (env.error !== undefined) {
          const message =
            typeof env.error.message === 'string' ? env.error.message : 'unknown error';
          finish(() => {
            reject(
              new CompanionError('http', `Companion rejected ${path}: ${message.slice(0, 200)}`, {
                writeAttempted,
              }),
            );
          });
          return;
        }
        const type = env.result?.type;
        if (type === 'started' || type === 'stopped') {
          return;
        }
        if (type === 'data' || type === undefined) {
          finish(() => {
            resolve(env.result?.data);
          });
        }
      });
    });
  }
}
