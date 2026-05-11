/** Log level: debug < info < warn < error, or none to disable all logs */
export type Level = "debug" | "info" | "warn" | "error" | "none"

/** Structured key-value attributes */
export type Attrs = Record<
  string,
  string | number | boolean | null | undefined | Record<string, unknown>
>

/** A metric instrument (Counter, UpDownCounter, or Histogram) */
export interface Metric {
  add?(value: number, attrs?: Attrs): void
  record?(value: number, attrs?: Attrs): void
}

/** Logger interface */
export interface Logger {
  debug(msg: string, attrs?: Attrs): Logger
  info(msg: string, attrs?: Attrs): Logger
  warn(msg: string, attrs?: Attrs): Logger
  error(msg: string, err: Error | null, attrs?: Attrs): Logger

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
