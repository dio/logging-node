import { describe, it, expect } from "vitest"
import { LoggerImpl } from "../src/logger"
import { withAttrs } from "../src/context"
import type { Sink } from "../src/sink"
import type { Metric, Level } from "../src/types"

class FakeMetric implements Metric {
  calls: Array<{
    value: number
    attrs?: Record<string, string | number | boolean | null | undefined>
  }> = []

  add(value: number, attrs?: any): void {
    this.calls.push({ value, attrs })
  }
}

class CaptureSink implements Sink {
  entries: Array<{ level: Level; msg: string; fields: Record<string, unknown> }> = []

  write(level: Level, msg: string, fields: Record<string, unknown>): void {
    this.entries.push({ level, msg, fields })
  }
}

describe("Context Attributes (v0.1.3 regression)", () => {
  it("merges context attrs into both logs and metrics", async () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })
    const counter = new FakeMetric()

    await withAttrs({ customer_id: "acme" }, async () => {
      logger.metric(counter).info("order placed")
    })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0].fields.customer_id).toBe("acme")

    expect(counter.calls).toHaveLength(1)
    expect(counter.calls[0].attrs?.customer_id).toBe("acme")
  })

  it("attributes flow through nested withAttrs", async () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    await withAttrs({ env: "prod" }, async () => {
      await withAttrs({ tenant_id: "xyz" }, async () => {
        logger.info("nested")
      })
    })

    expect(sink.entries).toHaveLength(1)
    const fields = sink.entries[0].fields
    expect(fields.env).toBe("prod")
    expect(fields.tenant_id).toBe("xyz")
  })

  it("does not leak attributes between parallel async chains", async () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const p1 = withAttrs({ id: "1" }, async () => {
      await new Promise((r) => setImmediate(r))
      logger.info("p1")
    })

    const p2 = withAttrs({ id: "2" }, async () => {
      await new Promise((r) => setImmediate(r))
      logger.info("p2")
    })

    await Promise.all([p1, p2])

    expect(sink.entries).toHaveLength(2)
    // Each should have its own id
    const ids = sink.entries.map((e) => e.fields.id).sort()
    expect(ids).toEqual(["1", "2"])
  })

  it("later attrs override earlier ones", async () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    await withAttrs({ level: "outer" }, async () => {
      await withAttrs({ level: "inner" }, async () => {
        logger.info("msg")
      })
    })

    expect(sink.entries[0].fields.level).toBe("inner")
  })
})
