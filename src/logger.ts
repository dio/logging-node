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

function serializeError(err: Error | null): SerializedError | null {
  if (!err) return null
  return {
    message: err.message,
    stack: err.stack,
    name: err.name,
    cause: (err as any).cause,
  }
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

  debug(msg: string, attrs?: Attrs): Logger {
    this.logWithMetric("debug", msg, attrs)
    return this
  }

  info(msg: string, attrs?: Attrs): Logger {
    this.logWithMetric("info", msg, attrs)
    return this
  }

  warn(msg: string, attrs?: Attrs): Logger {
    this.logWithMetric("warn", msg, attrs)
    return this
  }

  error(msg: string, err: Error | null, attrs?: Attrs): Logger {
    const merged = { ...attrs, ...(err ? { err: serializeError(err) as any } : {}) }
    this.logWithMetric("error", msg, merged as Attrs)
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
