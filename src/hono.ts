import type { MiddlewareHandler, Context as HonoContext } from "hono"
import { withAttrs, log } from "./index.js"

export interface LoggingMiddlewareOptions {
  logger?: typeof log
  attrs?: (c: HonoContext) => Record<string, unknown>
  generateRequestId?: () => string
}

export function loggingMiddleware(opts?: LoggingMiddlewareOptions): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    const requestId =
      opts?.generateRequestId?.() ?? c.req.header("x-request-id") ?? crypto.randomUUID()

    const url = new URL(c.req.url)
    const baseAttrs = {
      request_id: requestId,
      method: c.req.method,
      path: url.pathname,
      ...opts?.attrs?.(c),
    }

    const start = Date.now()
    const logger = opts?.logger ?? log

    return await withAttrs(baseAttrs, async () => {
      let thrown: unknown = undefined
      try {
        await next()
      } catch (err) {
        // Some Hono versions / setups rethrow; others store on c.error.
        thrown = err
      }
      const durationMs = Date.now() - start
      // Hono stores uncaught handler errors on c.error even when not rethrown.
      const honoErr = (c as unknown as { error?: unknown }).error
      const failure = thrown ?? honoErr
      if (failure) {
        logger.error("request failed", failure as Error, {
          status: c.res?.status ?? 500,
          duration_ms: durationMs,
        })
        if (thrown) throw thrown
        return
      }
      logger.info("request handled", {
        status: c.res.status,
        duration_ms: durationMs,
      })
    })
  }
}
