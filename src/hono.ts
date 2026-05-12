import type { MiddlewareHandler, Context as HonoContext } from "hono"
import { withAttrs, log } from "./index.js"

export interface LoggingMiddlewareOptions {
  /** Logger instance to use. Defaults to the global logger. */
  logger?: typeof log

  /** Additional attrs to attach to every request (called once per request). */
  attrs?: (c: HonoContext) => Record<string, unknown>

  /**
   * Override the request_id generator. When provided, this WINS over
   * header-based resolution. Use this for opaque/non-tracing IDs.
   */
  generateRequestId?: () => string

  /**
   * Ordered list of headers to try when resolving request_id.
   * The first header that yields a non-empty value wins. Defaults to:
   *   ["x-cloud-trace-context", "x-request-id"]
   *
   * `x-cloud-trace-context` is the GCP standard (Cloud Load Balancer,
   * Cloud Run, App Engine) — the header value is `TRACE_ID/SPAN_ID;o=FLAGS`
   * and we extract just the TRACE_ID portion as request_id. This lets log
   * entries correlate 1:1 with GCP Cloud Trace spans in the Cloud Logging UI.
   *
   * `x-request-id` is the generic convention (most reverse proxies, Envoy).
   *
   * Set to `[]` to skip header resolution and always generate a UUID.
   */
  requestIdHeaders?: string[]
}

const DEFAULT_REQUEST_ID_HEADERS = ["x-cloud-trace-context", "x-request-id"]

/**
 * Extract the trace ID portion from a header value.
 *
 *   x-cloud-trace-context: TRACE_ID/SPAN_ID;o=TRACE_TRUE
 *   x-request-id:          opaque-string
 *
 * Returns undefined for empty values.
 */
function parseRequestIdHeader(headerName: string, value: string): string | undefined {
  if (!value) return undefined
  if (headerName.toLowerCase() === "x-cloud-trace-context") {
    // Format: TRACE_ID/SPAN_ID;o=FLAGS — keep TRACE_ID only.
    const traceId = value.split("/")[0]?.trim()
    return traceId || undefined
  }
  return value.trim() || undefined
}

function resolveRequestId(c: HonoContext, opts: LoggingMiddlewareOptions | undefined): string {
  if (opts?.generateRequestId) return opts.generateRequestId()
  const headers = opts?.requestIdHeaders ?? DEFAULT_REQUEST_ID_HEADERS
  for (const name of headers) {
    const raw = c.req.header(name)
    if (raw == null) continue
    const parsed = parseRequestIdHeader(name, raw)
    if (parsed) return parsed
  }
  return crypto.randomUUID()
}

export function loggingMiddleware(opts?: LoggingMiddlewareOptions): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    const requestId = resolveRequestId(c, opts)

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
