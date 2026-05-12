import { describe, it, expect } from "vitest"
import { LoggerImpl } from "../src/logger"
import type { Sink } from "../src/sink"
import type { Level } from "../src/types"

class CaptureSink implements Sink {
  entries: Array<{ level: Level; msg: string; fields: Record<string, unknown> }> = []

  write(level: Level, msg: string, fields: Record<string, unknown>): void {
    this.entries.push({ level, msg, fields })
  }
}

describe("Error Signature", () => {
  it("logs error with message and stack", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const err = new Error("something failed")
    logger.error("operation failed", err, { op: "reserve" })

    expect(sink.entries).toHaveLength(1)
    const entry = sink.entries[0]
    expect(entry.msg).toBe("operation failed")
    expect(entry.fields.op).toBe("reserve")

    const errField = entry.fields.err as any
    expect(errField).toBeDefined()
    expect(errField.message).toBe("something failed")
    expect(errField.stack).toBeDefined()
    expect(errField.name).toBe("Error")
  })

  it("logs error with null and attrs", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.error("no error here", null, { status: "ok" })

    expect(sink.entries).toHaveLength(1)
    const entry = sink.entries[0]
    expect(entry.msg).toBe("no error here")
    expect(entry.fields.status).toBe("ok")
    expect(entry.fields.err).toBeUndefined()
  })

  it("preserves error cause chain", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const cause = new Error("root cause")
    const err = new Error("wrapped", { cause })
    logger.error("failed", err)

    expect(sink.entries).toHaveLength(1)
    const errField = sink.entries[0].fields.err as any
    expect(errField.cause).toEqual(cause)
  })

  it("handles custom error types", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    class CustomError extends Error {
      constructor(
        message: string,
        public code: string,
      ) {
        super(message)
        this.name = "CustomError"
      }
    }

    const err = new CustomError("validation failed", "INVALID_INPUT")
    logger.error("request invalid", err)

    expect(sink.entries).toHaveLength(1)
    const errField = sink.entries[0].fields.err as any
    expect(errField.name).toBe("CustomError")
    expect(errField.message).toBe("validation failed")
  })
})
