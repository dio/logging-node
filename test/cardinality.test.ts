// Cardinality fix verification (v0.3.0).
//
// Confirms that the two-scope split keeps unbounded request-scoped
// fields off counter labels while still letting them decorate log
// records. Bug found in dio/tilik-node.

import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import type { Metric, Level, Attrs } from "../src/types"
import { createLogger, setGlobalLogger, log, withAttrs, withLogAttrs } from "../src"
import { loggingMiddleware } from "../src/hono"
import type { Sink } from "../src/sink"

class FakeMetric implements Metric {
  calls: { value: number; attrs?: Attrs }[] = []
  add(value: number, attrs?: Attrs): void {
    this.calls.push({ value, attrs })
  }
}

interface CapturedLog {
  level: Level
  msg: string
  attrs: Attrs
}

function makeCaptureSink(): { sink: Sink; entries: CapturedLog[] } {
  const entries: CapturedLog[] = []
  const sink: Sink = {
    write(level, msg, attrs) {
      entries.push({ level, msg, attrs: { ...attrs } })
    },
    child() {
      return sink
    },
    setLevel() {},
    level() {
      return "debug"
    },
  }
  return { sink, entries }
}

function installCaptureLogger() {
  const { sink, entries } = makeCaptureSink()
  const logger = createLogger({ name: "t", level: "debug" })
  // Test-only field swap. Stable enough for tests; documented as internal.
  ;(logger as unknown as { sink: Sink }).sink = sink
  setGlobalLogger(logger)
  return { entries }
}

describe("cardinality fix: metric-safe vs log-only attr scopes", () => {
  it("withLogAttrs decorates logs but is invisible to metrics", () => {
    const { entries } = installCaptureLogger()
    const counter = new FakeMetric()

    withLogAttrs({ request_id: "req-abc", path: "/v1/echo" }, () => {
      withAttrs({ customer: "acme" }, () => {
        log.metric(counter).info({ result: "ok" }, "event")
      })
    })

    // Metric got customer (bounded) + result (call-site), NOT request_id/path.
    expect(counter.calls).toHaveLength(1)
    const labels = counter.calls[0]!.attrs ?? {}
    expect(labels.customer).toBe("acme")
    expect(labels.result).toBe("ok")
    expect(labels).not.toHaveProperty("request_id")
    expect(labels).not.toHaveProperty("path")

    // Log got everything (minus call-site `result` was on the log call).
    expect(entries).toHaveLength(1)
    expect(entries[0]!.attrs.request_id).toBe("req-abc")
    expect(entries[0]!.attrs.path).toBe("/v1/echo")
    expect(entries[0]!.attrs.customer).toBe("acme")
    expect(entries[0]!.attrs.result).toBe("ok")
  })

  it("Hono loggingMiddleware with metricAttrs / logAttrs split", async () => {
    const { entries } = installCaptureLogger()
    const counter = new FakeMetric()

    const app = new Hono()
    app.use(
      "*",
      loggingMiddleware({
        metricAttrs: (c) => ({
          customer: c.req.header("x-customer") ?? "unknown",
        }),
        logAttrs: () => ({
          extra_log_only: "yes",
        }),
      }),
    )
    app.get("/v1/quota", (c) => {
      log.metric(counter).info({ result: "hit" }, "quota lookup")
      return c.text("ok")
    })

    const res = await app.request("/v1/quota", {
      headers: { "x-customer": "acme" },
    })
    expect(res.status).toBe(200)

    expect(counter.calls).toHaveLength(1)
    const labels = counter.calls[0]!.attrs ?? {}
    expect(labels.customer).toBe("acme")
    expect(labels.result).toBe("hit")
    // Unbounded fields stay OFF the counter.
    expect(labels).not.toHaveProperty("request_id")
    expect(labels).not.toHaveProperty("method")
    expect(labels).not.toHaveProperty("path")
    expect(labels).not.toHaveProperty("extra_log_only")

    const quotaLog = entries.find((e) => e.msg === "quota lookup")!
    expect(quotaLog.attrs.customer).toBe("acme")
    expect(quotaLog.attrs.request_id).toBeTypeOf("string")
    expect(quotaLog.attrs.method).toBe("GET")
    expect(quotaLog.attrs.path).toBe("/v1/quota")
    expect(quotaLog.attrs.extra_log_only).toBe("yes")
  })

  it("legacy `attrs` callback auto-splits known unbounded keys (back-compat)", async () => {
    const { entries } = installCaptureLogger()
    const counter = new FakeMetric()

    const app = new Hono()
    app.use(
      "*",
      loggingMiddleware({
        // Legacy single callback mixing both kinds.
        attrs: (c) => ({
          customer: c.req.header("x-customer") ?? "unknown",
          // user_agent is in KNOWN_UNBOUNDED_KEYS, lands on log-only.
          user_agent: c.req.header("user-agent") ?? "",
        }),
      }),
    )
    app.get("/legacy", (c) => {
      log.metric(counter).info({ stage: "done" }, "legacy")
      return c.text("ok")
    })

    const res = await app.request("/legacy", {
      headers: { "x-customer": "acme", "user-agent": "curl/8" },
    })
    expect(res.status).toBe(200)

    expect(counter.calls).toHaveLength(1)
    const labels = counter.calls[0]!.attrs ?? {}
    expect(labels.customer).toBe("acme")
    expect(labels.stage).toBe("done")
    expect(labels).not.toHaveProperty("user_agent")
    expect(labels).not.toHaveProperty("request_id")
    expect(labels).not.toHaveProperty("method")
    expect(labels).not.toHaveProperty("path")

    const legacyLog = entries.find((e) => e.msg === "legacy")!
    expect(legacyLog.attrs.user_agent).toBe("curl/8")
    expect(legacyLog.attrs.customer).toBe("acme")
  })
})
