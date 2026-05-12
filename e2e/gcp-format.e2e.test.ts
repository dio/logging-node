import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createGcpLogger } from "../src/gcp.js"

describe("GCP format e2e", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let emitted: Record<string, unknown>[]

  beforeEach(() => {
    emitted = []
    consoleSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      const s = String(line).trim()
      if (s.startsWith("{")) {
        try {
          emitted.push(JSON.parse(s))
        } catch {
          /* skip */
        }
      }
    })
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("emits GCP-shaped JSON across levels with error reporting on .error()", () => {
    const log = createGcpLogger({
      name: "test",
      level: "debug",
      project: "test-proj",
      serviceName: "svc",
      serviceVersion: "v1",
    })

    log.info("hello info")
    log.warn("hello warn")
    log.error({ err: new Error("boom") }, "hello error")

    expect(emitted.length).toBeGreaterThanOrEqual(3)

    const info = emitted.find((l) => l.message === "hello info")
    expect(info, "info entry not found").toBeDefined()
    expect(info!.severity).toBe("INFO")
    expect(typeof info!.timestamp).toBe("string")
    expect(/T.*Z$/.test(String(info!.timestamp))).toBe(true)
    // GCP convention: no raw `msg` / `time` fields
    expect(info!.msg).toBeUndefined()
    expect(info!.time).toBeUndefined()

    const warn = emitted.find((l) => l.message === "hello warn")
    expect(warn!.severity).toBe("WARNING")

    const err = emitted.find((l) => l.message === "hello error")
    expect(err!.severity).toBe("ERROR")
    expect(err!["@type"]).toBe(
      "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent",
    )
    expect(typeof err!.stack_trace).toBe("string")
    expect(String(err!.stack_trace)).toContain("boom")
    expect(err!.serviceContext).toMatchObject({ service: "svc", version: "v1" })

    // Non-error calls must NOT include @type
    expect(info!["@type"]).toBeUndefined()
    expect(warn!["@type"]).toBeUndefined()
  })

  it("rewrites trace_id/span_id into GCP trace fields when project is set", () => {
    const log = createGcpLogger({
      name: "test",
      level: "info",
      project: "test-proj",
    }).with({ trace_id: "abc123", span_id: "def456" })

    log.info("traced")

    const entry = emitted.find((l) => l.message === "traced")
    expect(entry, "traced entry not found").toBeDefined()
    expect(entry!["logging.googleapis.com/trace"]).toBe("projects/test-proj/traces/abc123")
    expect(entry!["logging.googleapis.com/spanId"]).toBe("def456")
    expect(entry!["logging.googleapis.com/trace_sampled"]).toBe(true)
    expect(entry!.trace_id).toBeUndefined()
    expect(entry!.span_id).toBeUndefined()
  })

  it("preserves arbitrary structured fields", () => {
    const log = createGcpLogger({ name: "test", level: "info" })
    log.info({ tenant: "acme", count: 42 }, "with fields")

    const entry = emitted.find((l) => l.message === "with fields")
    expect(entry).toBeDefined()
    expect(entry!.tenant).toBe("acme")
    expect(entry!.count).toBe(42)
  })
})
