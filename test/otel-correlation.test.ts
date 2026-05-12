import { describe, it, expect } from "vitest"
import { context, trace } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base"
import { LoggerImpl } from "../src/logger"
import { extractTraceFields } from "../src/context"
import type { Sink } from "../src/sink"
import type { Level } from "../src/types"

class CaptureSink implements Sink {
  entries: Array<{ level: Level; msg: string; fields: Record<string, unknown> }> = []

  write(level: Level, msg: string, fields: Record<string, unknown>): void {
    this.entries.push({ level, msg, fields })
  }
}

describe("OTel Trace Correlation", () => {
  it("extracts trace_id and span_id from active span", () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ exceptionHandler: () => {} })
    provider.addSpanProcessor({ onStart: () => {}, onEnd: () => exporter.export([]) })

    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("operation")

    const fields = extractTraceFields(context.active())
    // When no span active, fields should be empty
    expect(fields.trace_id).toBeUndefined()
    expect(fields.span_id).toBeUndefined()

    // Now test with an active span
    context.with(trace.setSpan(context.active(), span), () => {
      const activeFields = extractTraceFields(context.active())
      expect(activeFields.trace_id).toBeDefined()
      expect(activeFields.span_id).toBeDefined()
      expect(typeof activeFields.trace_id).toBe("string")
      expect(typeof activeFields.span_id).toBe("string")
    })
  })

  it("adds trace fields to log entries when span is active", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ exceptionHandler: () => {} })
    provider.addSpanProcessor({ onStart: () => {}, onEnd: () => exporter.export([]) })

    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("request")

    context.with(trace.setSpan(context.active(), span), () => {
      logger.info("request handled")

      expect(sink.entries).toHaveLength(1)
      const fields = sink.entries[0].fields
      expect(fields.trace_id).toBeDefined()
      expect(fields.span_id).toBeDefined()
    })
  })

  it("uses explicit context over active context", () => {
    const sink = new CaptureSink()
    const logger = new LoggerImpl(sink, { level: "debug" })

    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({ exceptionHandler: () => {} })
    provider.addSpanProcessor({ onStart: () => {}, onEnd: () => exporter.export([]) })

    const tracer = provider.getTracer("test")
    const span = tracer.startSpan("operation")
    const spanCtx = trace.setSpan(context.active(), span)

    // Log outside the context
    logger.info("outside")
    expect(sink.entries[0].fields.trace_id).toBeUndefined()

    // Log with explicit context
    const loggerWithCtx = logger.context(spanCtx)
    loggerWithCtx.info("inside")
    expect(sink.entries[1].fields.trace_id).toBeDefined()
  })
})
