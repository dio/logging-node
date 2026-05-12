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

describe("Error Signature (pino-style attrs-first)", () => {
  it("serializes Error instance under `err` key", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const err = new Error("something failed")
    logger.error({ err, op: "reserve" }, "operation failed")

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

  it("also accepts `error` key (pino convention); output normalized to `err`", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const err = new Error("compat path")
    logger.error({ error: err, op: "compat" }, "from pino-style call site")

    expect(sink.entries).toHaveLength(1)
    const entry = sink.entries[0]
    expect(entry.fields.op).toBe("compat")
    const errField = entry.fields.err as any
    expect(errField).toBeDefined()
    expect(errField.message).toBe("compat path")
    // `error` key should be removed after normalization
    expect(entry.fields.error).toBeUndefined()
  })

  it("plain attrs (no Error) pass through unchanged", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.error({ status: "ok" }, "no error here")

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
    logger.error({ err }, "failed")

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
    logger.error({ err }, "request invalid")

    expect(sink.entries).toHaveLength(1)
    const errField = sink.entries[0].fields.err as any
    expect(errField.name).toBe("CustomError")
    expect(errField.message).toBe("validation failed")
  })

  it("bare message (no attrs) works for all levels", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.debug("d")
    logger.info("i")
    logger.warn("w")
    logger.error("e")

    expect(sink.entries.map((e) => e.msg)).toEqual(["d", "i", "w", "e"])
  })
})
