// Edge entry point: does NOT import pino
export type { Level, Attrs, Logger, LoggerOptions, Metric } from "./types.js"
export {
  getAttrs,
  setAttrsOnContext,
  withAttrs,
  getLogAttrs,
  setLogAttrsOnContext,
  withLogAttrs,
  getOperation,
  setOperationOnContext,
} from "./context.js"
export type { OperationInfo } from "./context.js"
export { getGlobalLogger, setGlobalLogger, log } from "./global.js"

import { LoggerImpl } from "./logger.js"
import type { LoggerOptions, Logger } from "./types.js"
import { createEdgeSink } from "./sink-edge.js"

export function createLogger(opts?: LoggerOptions): Logger {
  const sink = createEdgeSink()
  return new LoggerImpl(sink, opts)
}
