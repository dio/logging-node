import { context } from "@opentelemetry/api"
import type { Level, Logger, LoggerOptions, Attrs, Metric } from "./types.js"
import { shouldLog } from "./levels.js"
import { getAttrs, extractTraceFields } from "./context.js"
import type { Sink } from "./sink.js"

interface SerializedError {
  message?: string
  stack?: string
  name?: string
  cause?: unknown
}

function serializeError(err: Error): SerializedError {
  return {
    message: err.message,
    stack: err.stack,
    name: err.name,
    cause: (err as any).cause,
  }
}

/**
 * Normalize attrs by serializing any Error instances under `err` or `error`
 * keys (pino-compatible behavior). Both keys are accepted on input; output
 * is always under `err` for consistency.
 */
function normalizeAttrs(attrs: Attrs | undefined): Attrs | undefined {
  if (!attrs) return attrs
  let needsCopy = false
  for (const k of ["err", "error"]) {
    const v = attrs[k]
    if (v instanceof Error) {
      needsCopy = true
      break
    }
  }
  if (!needsCopy) return attrs

  const out: Record<string, unknown> = { ...attrs }
  if (out.error instanceof Error) {
    out.err = serializeError(out.error)
    delete out.error
  }
  if (out.err instanceof Error) {
    out.err = serializeError(out.err)
  }
  return out as Attrs
}

/**
 * Parse the (attrs?, msg) | (msg) overload pair into a normalized pair.
 */
function parseArgs(a: Attrs | string, b?: string): { msg: string; attrs: Attrs | undefined } {
  if (typeof a === "string") {
    return { msg: a, attrs: undefined }
  }
  return { msg: b ?? "", attrs: a }
}

export class LoggerImpl implements Logger {
  private sink: Sink
  private bindings: Attrs
  private currentLevel: Level
  private overrideContext: any
  private boundMetric: Metric | null

  constructor(
    sink: Sink,
    private opts: LoggerOptions = {},
  ) {
    this.sink = sink
    this.bindings = {}
    this.currentLevel = opts.level ?? "info"
    this.overrideContext = null
    this.boundMetric = null
  }

  private clone(): LoggerImpl {
    const cloned = new LoggerImpl(this.sink, this.opts)
    cloned.bindings = { ...this.bindings }
    cloned.currentLevel = this.currentLevel
    cloned.overrideContext = this.overrideContext
    cloned.boundMetric = this.boundMetric
    return cloned
  }

  private mergeAttrs(callAttrs?: Attrs): Attrs {
    const ctx = this.overrideContext ?? context.active()
    const contextAttrs = getAttrs(ctx)
    const traceFields = extractTraceFields(ctx)

    return {
      ...this.bindings,
      ...contextAttrs,
      ...callAttrs,
      ...traceFields,
    }
  }

  private logWithMetric(level: Level, msg: string, callAttrs?: Attrs): void {
    // CRITICAL: metric call BEFORE level check (per RATIONALE.md)
    if (this.boundMetric) {
      // Metrics get bindings + context attrs + call attrs (NO trace fields)
      const metricsAttrs = { ...this.bindings, ...getAttrs(), ...callAttrs }
      const fn = (this.boundMetric as any).add ?? (this.boundMetric as any).record
      if (fn) {
        fn.call(this.boundMetric, 1, metricsAttrs)
      }
    }

    // Now check level
    if (!shouldLog(this.currentLevel, level)) return

    const merged = this.mergeAttrs(callAttrs)
    this.sink.write(level, msg, merged)
  }

  debug(a: Attrs | string, b?: string): Logger {
    const { msg, attrs } = parseArgs(a, b)
    this.logWithMetric("debug", msg, normalizeAttrs(attrs))
    return this
  }

  info(a: Attrs | string, b?: string): Logger {
    const { msg, attrs } = parseArgs(a, b)
    this.logWithMetric("info", msg, normalizeAttrs(attrs))
    return this
  }

  warn(a: Attrs | string, b?: string): Logger {
    const { msg, attrs } = parseArgs(a, b)
    this.logWithMetric("warn", msg, normalizeAttrs(attrs))
    return this
  }

  error(a: Attrs | string, b?: string): Logger {
    const { msg, attrs } = parseArgs(a, b)
    this.logWithMetric("error", msg, normalizeAttrs(attrs))
    return this
  }

  with(attrs: Attrs): Logger {
    const cloned = this.clone()
    cloned.bindings = { ...cloned.bindings, ...attrs }
    return cloned
  }

  context(ctx: any): Logger {
    const cloned = this.clone()
    cloned.overrideContext = ctx
    return cloned
  }

  metric(m: Metric): Logger {
    const cloned = this.clone()
    cloned.boundMetric = m
    return cloned
  }

  setLevel(level: Level): void {
    this.currentLevel = level
  }

  level(): Level {
    return this.currentLevel
  }

  child(attrs: Attrs): Logger {
    return this.with(attrs)
  }
}
