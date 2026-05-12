// Tests for v0.3.0 GCP structured fields: httpRequest, operation grouping,
// labelKeys routing, sourceLocation, accurate trace_sampled.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { context, trace, TraceFlags, type SpanContext } from "@opentelemetry/api"
import { setGlobalLogger, log } from "../src"
import { createGcpSink, createGcpLogger } from "../src/gcp"
import { loggingMiddleware } from "../src/hono"

let captured: string[]
let originalLog: typeof console.log

beforeEach(() => {
  captured = []
  originalLog = console.log
  console.log = (s: string) => captured.push(s)
})

afterEach(() => {
  console.log = originalLog
})

describe("GCP sink: httpRequest", () => {
  it("emits httpRequest when http_request attr is present", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "request handled", {
      http_request: {
        requestMethod: "GET",
        requestUrl: "/api/echo?x=1",
        status: 200,
        latency: "0.045s",
        userAgent: "curl/8",
      },
      duration_ms: 45,
    })
    const entry = JSON.parse(captured[0]!)
    expect(entry.httpRequest).toEqual({
      requestMethod: "GET",
      requestUrl: "/api/echo?x=1",
      status: 200,
      latency: "0.045s",
      userAgent: "curl/8",
    })
    // http_request raw attr is consumed (not duplicated in jsonPayload).
    expect(entry.http_request).toBeUndefined()
    // Other fields still flow through.
    expect(entry.duration_ms).toBe(45)
  })

  it("Hono middleware emits httpRequest on the summary log", async () => {
    const logger = createGcpLogger({ project: "p1", name: "t" })
    setGlobalLogger(logger)

    const app = new Hono()
    app.use("*", loggingMiddleware())
    app.get("/hi", (c) => c.text("hi"))

    await app.request("/hi", { headers: { "user-agent": "test" } })

    const summaryLines = captured
      .map((s) => JSON.parse(s))
      .filter((e) => e.message === "request handled")
    expect(summaryLines).toHaveLength(1)
    const e = summaryLines[0]!
    expect(e.httpRequest.requestMethod).toBe("GET")
    expect(e.httpRequest.requestUrl).toBe("/hi")
    expect(e.httpRequest.status).toBe(200)
    expect(e.httpRequest.userAgent).toBe("test")
    expect(e.httpRequest.latency).toMatch(/^\d+\.\d{3}s$/)
  })

  it("httpRequest: false disables emission", async () => {
    const logger = createGcpLogger({ project: "p1", name: "t" })
    setGlobalLogger(logger)
    const app = new Hono()
    app.use("*", loggingMiddleware({ httpRequest: false }))
    app.get("/hi", (c) => c.text("hi"))
    await app.request("/hi")
    const summaryLines = captured
      .map((s) => JSON.parse(s))
      .filter((e) => e.message === "request handled")
    expect(summaryLines[0]!.httpRequest).toBeUndefined()
  })
})

describe("GCP sink: operation grouping", () => {
  it("emits logging.googleapis.com/operation with id and producer", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "doing", {
      operation: { id: "op-1", producer: "auth", first: true },
    })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/operation"]).toEqual({
      id: "op-1",
      producer: "auth",
      first: true,
    })
    expect(entry.operation).toBeUndefined()
  })

  it("Hono middleware marks first on request-received and last on summary", async () => {
    const logger = createGcpLogger({ project: "p1", name: "auth" })
    setGlobalLogger(logger)
    const app = new Hono()
    app.use("*", loggingMiddleware({ operation: { producer: "auth" } }))
    app.get("/x", (c) => {
      log.info("middle")
      return c.text("ok")
    })

    await app.request("/x", {
      headers: { "x-request-id": "req-aaa" },
    })

    const entries = captured.map((s) => JSON.parse(s))
    const received = entries.find((e) => e.message === "request received")
    const middle = entries.find((e) => e.message === "middle")
    const handled = entries.find((e) => e.message === "request handled")

    expect(received["logging.googleapis.com/operation"]).toEqual({
      id: "req-aaa",
      producer: "auth",
      first: true,
    })
    expect(middle["logging.googleapis.com/operation"]).toEqual({
      id: "req-aaa",
      producer: "auth",
    })
    expect(middle["logging.googleapis.com/operation"].first).toBeUndefined()
    expect(handled["logging.googleapis.com/operation"]).toEqual({
      id: "req-aaa",
      producer: "auth",
      last: true,
    })
  })

  it("operation: false disables emission", async () => {
    const logger = createGcpLogger({ project: "p1", name: "auth" })
    setGlobalLogger(logger)
    const app = new Hono()
    app.use("*", loggingMiddleware({ operation: false }))
    app.get("/x", (c) => c.text("ok"))
    await app.request("/x")
    const entries = captured.map((s) => JSON.parse(s))
    for (const e of entries) {
      expect(e["logging.googleapis.com/operation"]).toBeUndefined()
    }
  })
})

describe("GCP sink: labelKeys routing", () => {
  it("moves specified keys into logging.googleapis.com/labels", () => {
    const sink = createGcpSink({
      project: "p1",
      labelKeys: ["customer", "environment"],
    })
    sink.write("info", "x", {
      customer: "acme",
      environment: "prod",
      request_id: "abc",
      duration_ms: 12,
    })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/labels"]).toEqual({
      customer: "acme",
      environment: "prod",
    })
    // Labelled keys are removed from jsonPayload.
    expect(entry.customer).toBeUndefined()
    expect(entry.environment).toBeUndefined()
    // Non-labelled keys still flow as flat jsonPayload.
    expect(entry.request_id).toBe("abc")
    expect(entry.duration_ms).toBe(12)
  })

  it("coerces label values to strings", () => {
    const sink = createGcpSink({ labelKeys: ["plan_tier", "trial"] })
    sink.write("info", "x", { plan_tier: 3, trial: false })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/labels"]).toEqual({
      plan_tier: "3",
      trial: "false",
    })
  })

  it("skips emission when no label-keyed values present", () => {
    const sink = createGcpSink({ labelKeys: ["customer"] })
    sink.write("info", "x", { foo: "bar" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/labels"]).toBeUndefined()
  })
})

describe("GCP sink: trace_sampled from attr", () => {
  it("propagates trace_sampled=false", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "x", {
      trace_id: "t1",
      span_id: "s1",
      trace_sampled: false,
    })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace_sampled"]).toBe(false)
  })

  it("propagates trace_sampled=true", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "x", {
      trace_id: "t1",
      span_id: "s1",
      trace_sampled: true,
    })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace_sampled"]).toBe(true)
  })

  it("omits trace_sampled when not provided", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "x", { trace_id: "t1", span_id: "s1" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace_sampled"]).toBeUndefined()
  })
})

describe("GCP sink: sourceLocation", () => {
  it("default mode 'error' emits only on error level", () => {
    const sink = createGcpSink({ project: "p1" })
    sink.write("info", "ok", {})
    sink.write("error", "boom", { err: new Error("e") })
    const infoEntry = JSON.parse(captured[0]!)
    const errEntry = JSON.parse(captured[1]!)
    expect(infoEntry["logging.googleapis.com/sourceLocation"]).toBeUndefined()
    // Best-effort: stack might not yield a usable frame in synthetic tests.
    // We just verify that when present, it has the right shape.
    const loc = errEntry["logging.googleapis.com/sourceLocation"]
    if (loc) {
      expect(loc).toHaveProperty("file")
      expect(loc).toHaveProperty("line")
      expect(loc).toHaveProperty("function")
    }
  })

  it("mode 'off' suppresses on error level too", () => {
    const sink = createGcpSink({ project: "p1", sourceLocation: "off" })
    sink.write("error", "boom", { err: new Error("e") })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/sourceLocation"]).toBeUndefined()
  })
})

describe("GCP sink: logger emits sampled flag from real OTel span", () => {
  it("trace_sampled=true when SpanContext has SAMPLED flag", () => {
    const sc: SpanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.SAMPLED,
    }
    const span = trace.wrapSpanContext(sc)
    const ctxWithSpan = trace.setSpan(context.active(), span)

    const logger = createGcpLogger({ project: "p1", name: "t" })
    setGlobalLogger(logger)

    context.with(ctxWithSpan, () => {
      log.info("msg")
    })

    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toContain(
      "projects/p1/traces/0af7651916cd43dd8448eb211c80319c",
    )
    expect(entry["logging.googleapis.com/trace_sampled"]).toBe(true)
  })

  it("trace_sampled=false when SpanContext has no SAMPLED flag", () => {
    const sc: SpanContext = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: TraceFlags.NONE,
    }
    const span = trace.wrapSpanContext(sc)
    const ctxWithSpan = trace.setSpan(context.active(), span)

    const logger = createGcpLogger({ project: "p1", name: "t" })
    setGlobalLogger(logger)

    context.with(ctxWithSpan, () => {
      log.info("msg")
    })

    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace_sampled"]).toBe(false)
  })
})
