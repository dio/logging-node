import { describe, it, expect } from "vitest"
import { createGcpSink } from "../src/gcp"

describe("GCP Sink", () => {
  it("maps pino levels to GCP severity strings", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink()

      sink.write("debug", "debug msg", {})
      sink.write("info", "info msg", {})
      sink.write("warn", "warn msg", {})
      sink.write("error", "error msg", {})

      expect(calls).toHaveLength(4)

      const debugEntry = JSON.parse(calls[0])
      const infoEntry = JSON.parse(calls[1])
      const warnEntry = JSON.parse(calls[2])
      const errorEntry = JSON.parse(calls[3])

      expect(debugEntry.severity).toBe("DEBUG")
      expect(infoEntry.severity).toBe("INFO")
      expect(warnEntry.severity).toBe("WARNING")
      expect(errorEntry.severity).toBe("ERROR")
    } finally {
      console.log = originalLog
    }
  })

  it("renames msg to message and time to timestamp (ISO format)", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink()
      sink.write("info", "test message", {})

      expect(calls).toHaveLength(1)
      const entry = JSON.parse(calls[0])

      expect(entry.message).toBe("test message")
      expect(entry.timestamp).toBeDefined()
      // ISO format check (YYYY-MM-DDTHH:mm:ss.sssZ)
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    } finally {
      console.log = originalLog
    }
  })

  it("adds GCP trace correlation when project and trace_id present", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink({ project: "my-project" })
      sink.write("info", "request", {
        trace_id: "abc123",
        span_id: "def456",
        other_field: "value",
      })

      expect(calls).toHaveLength(1)
      const entry = JSON.parse(calls[0])

      expect(entry["logging.googleapis.com/trace"]).toBe("projects/my-project/traces/abc123")
      expect(entry["logging.googleapis.com/spanId"]).toBe("def456")
      expect(entry["logging.googleapis.com/trace_sampled"]).toBe(true)

      // Raw trace_id and span_id should be removed
      expect(entry.trace_id).toBeUndefined()
      expect(entry.span_id).toBeUndefined()

      // Other fields should be present
      expect(entry.other_field).toBe("value")
    } finally {
      console.log = originalLog
    }
  })

  it("includes error reporting for error level with err field", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink({
        serviceName: "my-service",
        serviceVersion: "v1.0.0",
      })

      const err = new Error("something broke")
      sink.write("error", "operation failed", { err })

      expect(calls).toHaveLength(1)
      const entry = JSON.parse(calls[0])

      expect(entry["@type"]).toBe(
        "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
      )
      expect(entry.stack_trace).toContain("something broke")
      expect(entry.serviceContext.service).toBe("my-service")
      expect(entry.serviceContext.version).toBe("v1.0.0")

      // err field should be removed from entry
      expect(entry.err).toBeUndefined()
    } finally {
      console.log = originalLog
    }
  })

  it("uses env vars for service context when not provided", () => {
    const calls: string[] = []
    const originalLog = console.log
    const originalKService = process.env.K_SERVICE
    const originalKRevision = process.env.K_REVISION

    process.env.K_SERVICE = "cloud-run-service"
    process.env.K_REVISION = "v2"

    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink()
      const err = new Error("test")
      sink.write("error", "failed", { err })

      expect(calls).toHaveLength(1)
      const entry = JSON.parse(calls[0])

      expect(entry.serviceContext.service).toBe("cloud-run-service")
      expect(entry.serviceContext.version).toBe("v2")
    } finally {
      console.log = originalLog
      process.env.K_SERVICE = originalKService
      process.env.K_REVISION = originalKRevision
    }
  })

  it("does not include error reporting for info level", () => {
    const calls: string[] = []
    const originalLog = console.log
    console.log = (...args: any[]) => {
      calls.push(args[0])
    }

    try {
      const sink = createGcpSink()
      const err = new Error("should not be reported")
      sink.write("info", "all good", { err })

      expect(calls).toHaveLength(1)
      const entry = JSON.parse(calls[0])

      // Should not have error reporting fields
      expect(entry["@type"]).toBeUndefined()
      expect(entry.stack_trace).toBeUndefined()
      expect(entry.serviceContext).toBeUndefined()

      // But the err should still be in the entry as a regular field
      expect(entry.err).toBeDefined()
    } finally {
      console.log = originalLog
    }
  })
})
