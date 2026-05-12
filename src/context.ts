import {
  context,
  createContextKey,
  trace,
  isSpanContextValid,
  type Context,
} from "@opentelemetry/api"
import type { Attrs } from "./types.js"

const ATTRS_KEY = createContextKey("@tetratelabs/logging:attrs")

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
