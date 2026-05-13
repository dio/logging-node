import { pino } from "pino"
import type { Level } from "./types.js"
import { toPinoLevel } from "./levels.js"
import type { Sink, SinkOptions } from "./sink.js"

export function createPinoSink(opts?: SinkOptions): Sink {
  // Thread the wrapper level into pino. Without this, pino defaults to
  // "info" and silently drops debug records even when the wrapper would
  // let them through, leaving the caller wondering why LOG_LEVEL=debug
  // produces no debug output. An explicit `opts.pino.level` still wins.
  const pinoOpts = { ...(opts?.pino ?? {}) }
  if (opts?.level && pinoOpts.level === undefined) {
    pinoOpts.level = toPinoLevel(opts.level)
  }
  const pinoInstance = pino(pinoOpts)

  return {
    write(level: Level, msg: string, fields: Record<string, unknown>) {
      const pinoLevel = toPinoLevel(level)
      const logger = pinoInstance as any
      if (typeof logger[pinoLevel] === "function") {
        logger[pinoLevel](fields, msg)
      }
    },
  }
}
