import { describe, it, expect } from "vitest"
import { LoggerImpl } from "../src/logger"
import type { Sink } from "../src/sink"
import type { Metric, Level } from "../src/types"

// Mock metric that records calls
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

describe("Metric Bypass Guarantee", () => {
  it("fires metric before level check", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "error" })
    const counter = new FakeMetric()

    // Set level to "error" — info logs are silenced
    // But metric should still fire
    logger.metric(counter).info("this is silenced")

    expect(sink.entries).toHaveLength(0) // log was silenced
    expect(counter.calls).toHaveLength(1) // metric fired anyway
    expect(counter.calls[0].value).toBe(1)
  })

  it("metrics receive merged attributes", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })
    const counter = new FakeMetric()

    const child = logger.with({ env: "prod" })
    child.metric(counter).info("msg", { op: "create" })

    expect(counter.calls).toHaveLength(1)
    // Metric should have binding attrs but NOT trace fields (those are log-only)
    expect(counter.calls[0].attrs?.env).toBe("prod")
    expect(counter.calls[0].attrs?.op).toBe("create")
  })

  it("metric works with different instruments (record)", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "info" })

    // Histogram-like instrument with `record` instead of `add`
    const histogram = {
      record(value: number, attrs?: any) {
        this.calls ??= []
        this.calls.push({ value, attrs })
      },
      calls: [] as any[],
    }

    logger.metric(histogram).info("latency", { ms: 42 })

    expect(histogram.calls).toHaveLength(1)
    expect(histogram.calls[0].value).toBe(1)
  })
})
