import type { Logger } from "./types.js"

declare global {
  var __tetratelabs_logger: Logger | undefined
}

export function getGlobalLogger(): Logger {
  if (!globalThis.__tetratelabs_logger) {
    // Lazy initialization on first use
    const { LoggerImpl } = require("./logger.js")
    const { createPinoSink } = require("./sink-pino.js")
    const sink = createPinoSink()
    globalThis.__tetratelabs_logger = new LoggerImpl(sink)
  }
  return globalThis.__tetratelabs_logger!
}

export function setGlobalLogger(logger: Logger): void {
  globalThis.__tetratelabs_logger = logger
}

export const log: Logger = {
  debug(msg, attrs) {
    return getGlobalLogger().debug(msg, attrs)
  },
  info(msg, attrs) {
    return getGlobalLogger().info(msg, attrs)
  },
  warn(msg, attrs) {
    return getGlobalLogger().warn(msg, attrs)
  },
  error(msg, err, attrs) {
    return getGlobalLogger().error(msg, err, attrs)
  },
  with(attrs) {
    return getGlobalLogger().with(attrs)
  },
  context(ctx) {
    return getGlobalLogger().context(ctx)
  },
  metric(m) {
    return getGlobalLogger().metric(m)
  },
  setLevel(level) {
    getGlobalLogger().setLevel(level)
  },
  level() {
    return getGlobalLogger().level()
  },
  child(attrs) {
    return getGlobalLogger().child(attrs)
  },
}
