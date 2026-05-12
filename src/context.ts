import {
  context,
  createContextKey,
  trace,
  isSpanContextValid,
  type Context,
} from "@opentelemetry/api"
import type { Attrs } from "./types.js"

// Two scopes:
//
// 1. ATTRS_KEY (metric-safe attrs): keys here propagate to BOTH log records
//    AND counter labels. Reserved for bounded enums (customer, environment,
//    service_name, etc.). Anything unbounded here is a cardinality bomb.
//
// 2. LOG_ATTRS_KEY (log-only attrs): keys here propagate ONLY to log
//    records. Use for request_id, trace_id, method, path, ip, user_agent
//    and anything else with unbounded values.
//
// The Hono middleware splits its own attrs across these two scopes so
// downstream `log.metric(c).info(...)` calls do not accidentally label
// counters with per-request values.
const ATTRS_KEY = createContextKey("@tetratelabs/logging:attrs")
const LOG_ATTRS_KEY = createContextKey("@tetratelabs/logging:log-attrs")

export function getAttrs(ctx?: Context): Attrs {
  const activeCtx = ctx ?? context.active()
  const attrs = activeCtx.getValue(ATTRS_KEY) as Attrs | undefined
  return attrs ?? {}
}

export function setAttrsOnContext(ctx: Context, attrs: Attrs): Context {
  const existing = getAttrs(ctx)
  const merged = { ...existing, ...attrs }
  return ctx.setValue(ATTRS_KEY, merged)
}

export function withAttrs<T>(attrs: Attrs, fn: () => T): T {
  const ctx = setAttrsOnContext(context.active(), attrs)
  return context.with(ctx, fn)
}

/**
 * Read log-only attrs from the active context. These flow to log records
 * but NOT to counter labels.
 */
export function getLogAttrs(ctx?: Context): Attrs {
  const activeCtx = ctx ?? context.active()
  const attrs = activeCtx.getValue(LOG_ATTRS_KEY) as Attrs | undefined
  return attrs ?? {}
}

/**
 * Attach log-only attrs to a context. Use for unbounded values like
 * request_id, method, path. Merges with any existing log attrs.
 */
export function setLogAttrsOnContext(ctx: Context, attrs: Attrs): Context {
  const existing = getLogAttrs(ctx)
  const merged = { ...existing, ...attrs }
  return ctx.setValue(LOG_ATTRS_KEY, merged)
}

/**
 * Run `fn` with log-only attrs bound to the active context. Anything in
 * `attrs` decorates log records but is NEVER attached to metrics.
 */
export function withLogAttrs<T>(attrs: Attrs, fn: () => T): T {
  const ctx = setLogAttrsOnContext(context.active(), attrs)
  return context.with(ctx, fn)
}

export function extractTraceFields(ctx: Context): Record<string, string> {
  const fields: Record<string, string> = {}
  const span = trace.getSpan(ctx)
  if (span) {
    const sc = span.spanContext()
    if (isSpanContextValid(sc)) {
      fields.trace_id = sc.traceId
      fields.span_id = sc.spanId
    }
  }
  return fields
}
