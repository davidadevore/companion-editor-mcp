import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CompanionError } from './companion-client.js';
import type { Logger } from './logger.js';

export interface ToolOutcome {
  readonly summary: string;
  readonly data: Record<string, unknown>;
  readonly refused?: boolean;
  readonly dryRun?: boolean;
  /** Logged instead of summary when the summary carries data that should stay out of the audit log. */
  readonly logDetail?: string;
}

export type GuardedHandler<Args> = (args: Args) => Promise<ToolOutcome>;

export function toResult(outcome: ToolOutcome): CallToolResult {
  return {
    content: [{ type: 'text', text: outcome.summary }],
    structuredContent: outcome.data,
    ...(outcome.refused === true ? { isError: true } : {}),
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

export const UNKNOWN_OUTCOME = 'Outcome unknown, verify in Companion before acting again.';

export function safeErrorMessage(err: unknown): string {
  if (err instanceof CompanionError) {
    if (err.kind === 'timeout' || err.writeAttempted) {
      return `${err.message}. ${UNKNOWN_OUTCOME}`;
    }
    return err.message;
  }
  return 'internal error';
}

export function guard<Args>(
  logger: Logger,
  tool: string,
  handler: GuardedHandler<Args>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const outcome = await handler(args);
      logger.log({
        tool,
        args,
        outcome: outcome.refused === true ? 'refused' : 'ok',
        allowed: outcome.refused !== true,
        ...(outcome.dryRun === undefined ? {} : { dryRun: outcome.dryRun }),
        detail: outcome.logDetail ?? outcome.summary,
        durationMs: Date.now() - started,
      });
      return toResult(outcome);
    } catch (err) {
      const message = safeErrorMessage(err);
      logger.log({
        tool,
        args,
        outcome: 'error',
        allowed: true,
        detail: message,
        durationMs: Date.now() - started,
      });
      return errorResult(message);
    }
  };
}
