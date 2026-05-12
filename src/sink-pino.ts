import { pino } from "pino"
import type { Level } from "./types.js"
import { toPinoLevel } from "./levels.js"
import type { Sink, SinkOptions } from "./sink.js"

export function createPinoSink(opts?: SinkOptions): Sink {
  const pinoInstance = pino(opts?.pino ?? {})

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
