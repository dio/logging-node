import type { Level } from "./types.js"

export interface Sink {
  write(level: Level, msg: string, fields: Record<string, unknown>): void
}

export interface SinkOptions {
  name?: string
  level?: Level
  pino?: any
}

export function createSink(opts?: SinkOptions): Sink {
  const isEdge =
    (typeof process !== "undefined" && process.env.NEXT_RUNTIME === "edge") ||
    typeof (globalThis as any).EdgeRuntime !== "undefined"

  if (isEdge) {
    return createEdgeSink()
  } else {
    return createPinoSink(opts)
  }
}

function createPinoSink(opts?: SinkOptions): Sink {
  // Lazy import to avoid pulling pino into edge bundle
  const { createPinoSink: createPinoSinkImpl } = require("./sink-pino.js")
  return createPinoSinkImpl(opts)
}

function createEdgeSink(): Sink {
  // Lazy import to keep edge bundle clean
  const { createEdgeSink: createEdgeSinkImpl } = require("./sink-edge.js")
  return createEdgeSinkImpl()
}
