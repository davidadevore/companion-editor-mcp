/**
 * Shared write path for the internal-API tools: per-target limiter, then an "attempt"
 * audit line, then the write. Used by config-tools.ts and trigger-tools.ts.
 */
import type { AppContext } from '../context.js';
import type { ToolOutcome } from '../guard.js';
import type { WriteLimiter } from '../safety.js';

const LOGGER_UNHEALTHY = 'audit log is not writable, writes are refused until it is';

export const INTERNAL_API_NOTE =
  ' Uses Companion\u0027s internal admin API (not the documented HTTP API): verified against 5.1.0, may break on other versions, fails closed if the response shape is unexpected.';

export function refused(
  summary: string,
  data: Record<string, unknown>,
  dryRun: boolean,
): ToolOutcome {
  return {
    summary: `REFUSED: ${summary}`,
    data: { ...data, refused: true },
    refused: true,
    dryRun,
  };
}

export function makePerformWrite(ctx: AppContext, limiter: WriteLimiter) {
  return async function performWrite(
    tool: string,
    key: string,
    logArgs: Record<string, unknown>,
    intent: string,
    data: Record<string, unknown>,
    run: () => Promise<ToolOutcome>,
  ): Promise<ToolOutcome> {
    const slot = limiter.acquire(key);
    if (!slot.ok) {
      return refused(slot.reason, { ...data, reason: slot.reason }, false);
    }
    try {
      const logged = ctx.logger.log({
        tool,
        args: logArgs,
        outcome: 'attempt',
        allowed: true,
        dryRun: false,
        detail: intent,
      });
      if (!logged) {
        return refused(LOGGER_UNHEALTHY, { ...data, reason: LOGGER_UNHEALTHY }, false);
      }
      return await run();
    } finally {
      slot.release();
    }
  };
}
