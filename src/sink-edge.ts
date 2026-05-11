import type { Level } from "./types.js"
import type { Sink } from "./sink.js"

export function createEdgeSink(): Sink {
  return {
    write(level: Level, msg: string, fields: Record<string, unknown>) {
      // Edge sink: always write (filtering happens at logger level, not sink level)
      // The logger already checks shouldLog before calling sink.write
      const now = new Date().toISOString()
      const entry = {
        level,
        time: now,
        msg,
        ...fields,
      }
      console.log(JSON.stringify(entry))
    },
  }
}
