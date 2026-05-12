import { describe, it, expect, beforeEach, afterEach } from "vitest"
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

  describe("default value resolution", () => {
    // Each test snapshots and restores process.env so they don't leak.
    const originalEnv = { ...process.env }
    let originalLog: typeof console.log
    const captured: string[] = []

    beforeEach(() => {
      // Clear all relevant env vars to start from a known state.
      for (const k of [
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "K_SERVICE",
        "K_REVISION",
        "OTEL_SERVICE_NAME",
        "OTEL_SERVICE_VERSION",
        "npm_package_name",
        "npm_package_version",
      ]) {
        delete process.env[k]
      }
      captured.length = 0
      originalLog = console.log
      console.log = (line: string) => {
        captured.push(line)
      }
    })

    afterEach(() => {
      console.log = originalLog
      process.env = { ...originalEnv }
    })

    it("falls back to GOOGLE_CLOUD_PROJECT for trace correlation", () => {
      process.env.GOOGLE_CLOUD_PROJECT = "env-project"
      const sink = createGcpSink()
      sink.write("info", "test", { trace_id: "abc123" })
      const entry = JSON.parse(captured[0])
      expect(entry["logging.googleapis.com/trace"]).toBe("projects/env-project/traces/abc123")
    })

    it("falls back to GCLOUD_PROJECT when GOOGLE_CLOUD_PROJECT is unset", () => {
      process.env.GCLOUD_PROJECT = "legacy-project"
      const sink = createGcpSink()
      sink.write("info", "test", { trace_id: "xyz" })
      const entry = JSON.parse(captured[0])
      expect(entry["logging.googleapis.com/trace"]).toBe("projects/legacy-project/traces/xyz")
    })

    it("falls back to OTEL_SERVICE_NAME and OTEL_SERVICE_VERSION", () => {
      process.env.OTEL_SERVICE_NAME = "otel-svc"
      process.env.OTEL_SERVICE_VERSION = "otel-v1"
      const sink = createGcpSink()
      sink.write("error", "boom", { err: new Error("x") })
      const entry = JSON.parse(captured[0])
      expect(entry.serviceContext).toEqual({ service: "otel-svc", version: "otel-v1" })
    })

    it("K_SERVICE/K_REVISION take priority over OTEL_*", () => {
      process.env.K_SERVICE = "cloud-run-svc"
      process.env.K_REVISION = "rev-42"
      process.env.OTEL_SERVICE_NAME = "should-be-ignored"
      const sink = createGcpSink()
      sink.write("error", "boom", { err: new Error("x") })
      const entry = JSON.parse(captured[0])
      expect(entry.serviceContext).toEqual({
        service: "cloud-run-svc",
        version: "rev-42",
      })
    })

    it("uses opts.name as service when no env vars are set", () => {
      const sink = createGcpSink({ name: "from-opts" })
      sink.write("error", "boom", { err: new Error("x") })
      const entry = JSON.parse(captured[0])
      expect(entry.serviceContext?.service).toBe("from-opts")
      expect(entry.serviceContext?.version).toBe("unknown")
    })

    it("falls back to npm_package_name and npm_package_version", () => {
      process.env.npm_package_name = "my-pkg"
      process.env.npm_package_version = "1.2.3"
      const sink = createGcpSink()
      sink.write("error", "boom", { err: new Error("x") })
      const entry = JSON.parse(captured[0])
      expect(entry.serviceContext).toEqual({ service: "my-pkg", version: "1.2.3" })
    })

    it("explicit opts override all env fallbacks", () => {
      process.env.K_SERVICE = "cloud-run"
      process.env.GOOGLE_CLOUD_PROJECT = "env-proj"
      const sink = createGcpSink({
        serviceName: "explicit-svc",
        serviceVersion: "explicit-v1",
        project: "explicit-proj",
      })
      sink.write("error", "boom", { err: new Error("x"), trace_id: "t1" })
      const entry = JSON.parse(captured[0])
      expect(entry["logging.googleapis.com/trace"]).toBe("projects/explicit-proj/traces/t1")
      expect(entry.serviceContext).toEqual({
        service: "explicit-svc",
        version: "explicit-v1",
      })
    })

    it("skips trace correlation when no project is resolvable", () => {
      const sink = createGcpSink()
      sink.write("info", "test", { trace_id: "abc" })
      const entry = JSON.parse(captured[0])
      expect(entry["logging.googleapis.com/trace"]).toBeUndefined()
      // The raw trace_id stays in the entry as a regular field
      expect(entry.trace_id).toBe("abc")
    })

    it("final fallback to 'unknown' when nothing is available", () => {
      const sink = createGcpSink()
      sink.write("error", "boom", { err: new Error("x") })
      const entry = JSON.parse(captured[0])
      expect(entry.serviceContext).toEqual({ service: "unknown", version: "unknown" })
    })
  })
})
