import type { MiddlewareHandler, Context as HonoContext } from "hono"
import { context } from "@opentelemetry/api"
import { setAttrsOnContext, setLogAttrsOnContext, setOperationOnContext, log } from "./index.js"
import type { Attrs } from "./types.js"

// Well-known unbounded fields. When the legacy `attrs` option is used,
// these keys are auto-routed to log-only context so callers don't
// accidentally pollute metric labels.
const KNOWN_UNBOUNDED_KEYS = new Set([
  "request_id",
  "trace_id",
  "span_id",
  "method",
  "path",
  "url",
  "user_agent",
  "remote_ip",
  "referer",
])

export interface LoggingMiddlewareOptions {
  /** Logger instance to use. Defaults to the global logger. */
  logger?: typeof log

  /**
   * Metric-safe attrs: keys here propagate to BOTH log records and counter
   * labels. Use for bounded enums like `customer_id`, `environment`,
   * `service_name`. NEVER put unbounded values here (request_id, user_id,
   * raw IP) — they will explode counter cardinality.
   */
  metricAttrs?: (c: HonoContext) => Record<string, unknown>

  /**
   * Log-only attrs: keys here flow to log records but NEVER reach counter
   * labels. Use for `request_id`, `method`, `path`, and any other
   * unbounded request-scoped values.
   *
   * The middleware automatically adds `request_id`, `method`, and `path`
   * to this scope. Anything you return here is merged on top.
   */
  logAttrs?: (c: HonoContext) => Record<string, unknown>

  /**
   * @deprecated since v0.3.0 — use `metricAttrs` and/or `logAttrs` instead.
   *
   * Legacy single-scope attrs callback. When provided, the middleware
   * splits the returned object across log-only and metric-safe scopes
   * using a hard-coded heuristic: well-known unbounded keys (request_id,
   * trace_id, span_id, method, path, url, user_agent, remote_ip, referer)
   * go to log-only. Everything else goes to metric-safe.
   *
   * This shim exists for one release. Migrate to the two-callback API
   * before v0.4.0.
   */
  attrs?: (c: HonoContext) => Record<string, unknown>

  /**
   * Override the request_id generator. When provided, this WINS over
   * header-based resolution. Use this for opaque/non-tracing IDs.
   */
  generateRequestId?: () => string

  /**
   * Ordered list of headers to try when resolving request_id. Defaults to:
   *   ["x-cloud-trace-context", "x-request-id"]
   *
   * `x-cloud-trace-context` is the GCP standard (Cloud Load Balancer,
   * Cloud Run, App Engine). The header value is `TRACE_ID/SPAN_ID;o=FLAGS`
   * and we extract just the TRACE_ID portion. This lets log entries
   * correlate 1:1 with GCP Cloud Trace spans in the Cloud Logging UI.
   *
   * `x-request-id` is the generic convention (most reverse proxies, Envoy).
   *
   * Set to `[]` to skip header resolution and always generate a UUID.
   */
  requestIdHeaders?: string[]

  /**
   * Cloud Logging "operation" producer field. Used to group log entries
   * across a single request in the Cloud Logging UI. Defaults to
   * `OTEL_SERVICE_NAME` if set, otherwise omitted.
   *
   * Operations themselves are always emitted (the middleware marks the
   * first and last log lines so the UI knows when grouping starts and
   * ends). Set `operation: false` to disable entirely.
   */
  operation?: false | { producer?: string }

  /**
   * Emit the `httpRequest` structured field on the request summary log.
   * Enabled by default. Set to `false` to suppress.
   *
   * The Cloud Logging UI shows method/status/latency columns and adds
   * filtering chips when `httpRequest` is present.
   */
  httpRequest?: boolean
}

const DEFAULT_REQUEST_ID_HEADERS = ["x-cloud-trace-context", "x-request-id"]

function parseRequestIdHeader(headerName: string, value: string): string | undefined {
  if (!value) return undefined
  if (headerName.toLowerCase() === "x-cloud-trace-context") {
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

let warnedAboutLegacyAttrs = false

function splitLegacyAttrs(raw: Record<string, unknown>): {
  metric: Record<string, unknown>
  log: Record<string, unknown>
} {
  const metric: Record<string, unknown> = {}
  const log: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (KNOWN_UNBOUNDED_KEYS.has(k)) log[k] = v
    else metric[k] = v
  }
  return { metric, log }
}

export function loggingMiddleware(opts?: LoggingMiddlewareOptions): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    const requestId = resolveRequestId(c, opts)
    const url = new URL(c.req.url)

    // Always-on log-only attrs. These are unbounded by nature, so they
    // must never reach metric labels.
    const baseLogAttrs: Record<string, unknown> = {
      request_id: requestId,
      method: c.req.method,
      path: url.pathname,
    }

    let metricAttrs: Record<string, unknown> = {}
    let extraLogAttrs: Record<string, unknown> = {}

    if (opts?.metricAttrs) metricAttrs = { ...opts.metricAttrs(c) }
    if (opts?.logAttrs) extraLogAttrs = { ...opts.logAttrs(c) }

    if (opts?.attrs) {
      if (!warnedAboutLegacyAttrs) {
        warnedAboutLegacyAttrs = true
        // eslint-disable-next-line no-console
        console.warn(
          "[@tetratelabs/logging] loggingMiddleware: `attrs` is deprecated " +
            "and will be removed in v0.4.0. Migrate to `metricAttrs` (bounded " +
            "labels) and `logAttrs` (unbounded log-only fields). See " +
            "https://github.com/dio/logging-node/blob/main/docs/migration-0.3.md",
        )
      }
      const split = splitLegacyAttrs(opts.attrs(c))
      // Explicit `metricAttrs` / `logAttrs` win over the legacy callback.
      metricAttrs = { ...split.metric, ...metricAttrs }
      extraLogAttrs = { ...split.log, ...extraLogAttrs }
    }

    const finalLogAttrs = { ...baseLogAttrs, ...extraLogAttrs }

    // Build a context with both scopes attached.
    let ctx = context.active()
    if (Object.keys(metricAttrs).length > 0) {
      ctx = setAttrsOnContext(ctx, metricAttrs as Attrs)
    }
    ctx = setLogAttrsOnContext(ctx, finalLogAttrs as Attrs)

    // Operation grouping. The middleware writes operation into the
    // OTel context without first/last flags. Bookend logs (the explicit
    // "request received" and "request handled/failed" lines) override
    // by passing `operation` as a call attr with first/last set.
    const opEnabled = opts?.operation !== false
    const producer = (opts?.operation && opts.operation.producer) || process.env.OTEL_SERVICE_NAME
    const opBase = opEnabled ? { id: requestId, ...(producer ? { producer } : {}) } : undefined
    if (opBase) {
      ctx = setOperationOnContext(ctx, opBase)
    }
    const opFirst: Attrs = opBase ? { operation: { ...opBase, first: true } } : {}
    const opLast: Attrs = opBase ? { operation: { ...opBase, last: true } } : {}

    const start = Date.now()
    const logger = opts?.logger ?? log
    const emitHttpRequest = opts?.httpRequest !== false

    return await context.with(ctx, async () => {
      // Bookend: explicit "first" log line so the Cloud Logging UI
      // knows where the operation starts.
      if (opBase) {
        logger.info(opFirst, "request received")
      }

      let thrown: unknown = undefined
      try {
        await next()
      } catch (err) {
        thrown = err
      }
      const durationMs = Date.now() - start
      const honoErr = (c as unknown as { error?: unknown }).error
      const failure = thrown ?? honoErr

      const httpRequest = emitHttpRequest ? buildHttpRequest(c, durationMs) : undefined

      if (failure) {
        logger.error(
          {
            err: failure as Error,
            status: c.res?.status ?? 500,
            duration_ms: durationMs,
            ...(httpRequest ? { http_request: httpRequest } : {}),
            ...opLast,
          },
          "request failed",
        )
        if (thrown) throw thrown
        return
      }
      logger.info(
        {
          status: c.res.status,
          duration_ms: durationMs,
          ...(httpRequest ? { http_request: httpRequest } : {}),
          ...opLast,
        },
        "request handled",
      )
    })
  }
}

function buildHttpRequest(c: HonoContext, durationMs: number): Record<string, unknown> {
  const url = new URL(c.req.url)
  const status = c.res?.status ?? 0
  const out: Record<string, unknown> = {
    requestMethod: c.req.method,
    requestUrl: url.pathname + url.search,
    status,
    latency: `${(durationMs / 1000).toFixed(3)}s`,
  }
  const ua = c.req.header("user-agent")
  if (ua) out.userAgent = ua
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip")
  if (ip) out.remoteIp = String(ip).split(",")[0]!.trim()
  const referer = c.req.header("referer")
  if (referer) out.referer = referer
  return out
}
