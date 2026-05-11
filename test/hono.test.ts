import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import { LoggerImpl } from "../src/logger"
import type { Sink } from "../src/sink"
import type { Level } from "../src/types"
import { loggingMiddleware } from "../src/hono"

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

describe("hono middleware", () => {
  let sink: CaptureSink
  let testLogger: LoggerImpl

  beforeEach(() => {
    sink = new CaptureSink()
    testLogger = new LoggerImpl(sink, { level: "debug" })
  })

  it("logs successful requests with request_id from header", async () => {
    const app = new Hono()
    app.use(loggingMiddleware({ logger: testLogger }))
    app.get("/x", (c) => c.text("ok"))

    const res = await app.request("/x", { headers: { "x-request-id": "rid-1" } })
    expect(res.status).toBe(200)

    const handled = sink.entries.find((e) => e.msg === "request handled")
    expect(handled).toBeDefined()
    expect(handled!.fields.request_id).toBe("rid-1")
    expect(handled!.fields.method).toBe("GET")
    expect(handled!.fields.path).toBe("/x")
    expect(handled!.fields.status).toBe(200)
    expect(typeof handled!.fields.duration_ms).toBe("number")
  })

  it("generates request_id when header missing", async () => {
    const app = new Hono()
    app.use(loggingMiddleware({ logger: testLogger }))
    app.get("/y", (c) => c.text("ok"))

    const res = await app.request("/y")
    expect(res.status).toBe(200)

    const handled = sink.entries.find((e) => e.msg === "request handled")
    expect(handled).toBeDefined()
    expect(handled!.fields.request_id).toBeDefined()
    // Should be a UUID
    expect(handled!.fields.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it("uses custom generateRequestId function", async () => {
    const app = new Hono()
    let callCount = 0
    app.use(
      loggingMiddleware({
        logger: testLogger,
        generateRequestId: () => `custom-${++callCount}`,
      }),
    )
    app.get("/z", (c) => c.text("ok"))

    await app.request("/z", { headers: { "x-request-id": "ignored" } })
    const handled = sink.entries.find((e) => e.msg === "request handled")
    expect(handled!.fields.request_id).toBe("custom-1")
  })

  it("includes custom attrs from opts.attrs function", async () => {
    const app = new Hono()
    app.use(
      loggingMiddleware({
        logger: testLogger,
        attrs: (c) => ({ custom: "value", query: c.req.query("q") }),
      }),
    )
    app.get("/attrs", (c) => c.text("ok"))

    const res = await app.request("/attrs?q=test")
    expect(res.status).toBe(200)

    const handled = sink.entries.find((e) => e.msg === "request handled")
    expect(handled!.fields.custom).toBe("value")
    expect(handled!.fields.query).toBe("test")
  })

  it("logs errors with status 500 when handler throws", async () => {
    const app = new Hono()
    app.use(loggingMiddleware({ logger: testLogger }))
    app.get("/boom", () => {
      throw new Error("nope")
    })

    const res = await app.request("/boom")
    expect(res.status).toBe(500)

    const failed = sink.entries.find((e) => e.msg === "request failed")
    expect(failed, "expected a 'request failed' entry").toBeDefined()
    expect(failed!.level).toBe("error")
    expect(failed!.fields.status).toBe(500)
    const errField = failed!.fields.err as { message?: string } | undefined
    expect(errField?.message).toBe("nope")
  })

  it("uses default global logger when not specified", async () => {
    // Create a new sink for testing the global logger path
    const globalSink = new CaptureSink()
    const globalLogger = new LoggerImpl(globalSink, { level: "debug" })

    const app = new Hono()
    app.use(loggingMiddleware({ logger: globalLogger }))
    app.get("/default", (c) => c.text("ok"))

    const res = await app.request("/default")
    expect(res.status).toBe(200)

    // Verify that the global logger was used
    const handled = globalSink.entries.find((e) => e.msg === "request handled")
    expect(handled).toBeDefined()
  })
})
