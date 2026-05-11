import { describe, it, expect } from "vitest"
import { LoggerImpl } from "../src/logger"
import type { Sink } from "../src/sink"
import type { Level } from "../src/types"

// Test helper: capture sink writes
class CaptureSink implements Sink {
  entries: Array<{
    level: Level
    msg: string
    fields: Record<string, unknown>
  }> = []

  write(level: Level, msg: string, fields: Record<string, unknown>): void {
    this.entries.push({ level, msg, fields })
  }
}

describe("Logger", () => {
  it("logs at different levels", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.debug("debug msg", { key: "val" })
    logger.info("info msg")
    logger.warn("warn msg")
    logger.error("error msg", null)

    expect(sink.entries).toHaveLength(4)
    expect(sink.entries[0].level).toBe("debug")
    expect(sink.entries[0].msg).toBe("debug msg")
    expect(sink.entries[0].fields.key).toBe("val")
    expect(sink.entries[1].level).toBe("info")
    expect(sink.entries[3].level).toBe("error")
  })

  it("respects level filtering", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "warn" })

    logger.debug("debug")
    logger.info("info")
    logger.warn("warn")
    logger.error("error")

    expect(sink.entries).toHaveLength(2)
    expect(sink.entries[0].msg).toBe("warn")
    expect(sink.entries[1].msg).toBe("error")
  })

  it("supports with() for child loggers with bindings", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })
    const child = logger.with({ request_id: "123" })

    child.info("msg", { extra: "field" })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0].fields.request_id).toBe("123")
    expect(sink.entries[0].fields.extra).toBe("field")
  })

  it("allows runtime level changes", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "info" })

    logger.info("visible")
    expect(sink.entries).toHaveLength(1)

    logger.setLevel("error")
    logger.info("hidden")
    logger.error("visible again")

    expect(sink.entries).toHaveLength(2)
    expect(sink.entries[1].msg).toBe("visible again")
  })

  it("encodes errors in error logs", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const err = new Error("boom")
    logger.error("failed", err)

    expect(sink.entries).toHaveLength(1)
    const errField = sink.entries[0].fields.err as any
    expect(errField.message).toBe("boom")
    expect(errField.stack).toBeDefined()
    expect(errField.name).toBe("Error")
  })

  it("handles null error in error logs", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.error("something went wrong", null, { code: "ERR_001" })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0].fields.code).toBe("ERR_001")
    expect(sink.entries[0].fields.err).toBeUndefined()
  })

  it("supports chaining for fluent API", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    logger.debug("d").info("i").warn("w").error("e", null)

    expect(sink.entries).toHaveLength(4)
  })

  it("level() returns current level", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "warn" })
    expect(logger.level()).toBe("warn")

    logger.setLevel("debug")
    expect(logger.level()).toBe("debug")
  })

  it("child() is an alias for with()", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })
    const child = logger.child({ id: "xyz" })

    child.info("msg")
    expect(sink.entries[0].fields.id).toBe("xyz")
  })
})
