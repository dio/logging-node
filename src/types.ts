/** Log level: debug < info < warn < error, or none to disable all logs */
export type Level = "debug" | "info" | "warn" | "error" | "none"

/**
 * Structured key-value attributes. Values can be primitives, plain objects,
 * or Error instances (the latter are auto-serialized when keyed as `err`
 * or `error`).
 */
export type Attrs = Record<
  string,
  string | number | boolean | null | undefined | Error | Record<string, unknown>
>

/** A metric instrument (Counter, UpDownCounter, or Histogram) */
export interface Metric {
  add?(value: number, attrs?: Attrs): void
  record?(value: number, attrs?: Attrs): void
}

/**
 * Logger interface — pino-style attrs-first signatures.
 *
 * Usage:
 *   log.info("bare message")
 *   log.info({ user_id: "x" }, "with attrs")
 *   log.error({ err: someError, retry: 3 }, "failed")
 *
 * The library auto-serializes Error instances when keyed as `err` or
 * `error` (matching pino's standard `err` serializer).
 */
export interface Logger {
  debug(msg: string): Logger
  debug(attrs: Attrs, msg: string): Logger

  info(msg: string): Logger
  info(attrs: Attrs, msg: string): Logger

  warn(msg: string): Logger
  warn(attrs: Attrs, msg: string): Logger

  error(msg: string): Logger
  error(attrs: Attrs, msg: string): Logger

  with(attrs: Attrs): Logger
  context(ctx: any): Logger
  metric(m: Metric): Logger
  setLevel(level: Level): void
  level(): Level
  child(attrs: Attrs): Logger
}

/** Options for creating a logger */
export interface LoggerOptions {
  name?: string
  level?: Level
  pino?: any // PinoOptionsSubset — avoid circular dep
}
