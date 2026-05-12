// Tests for GCP project auto-detection (v0.3.0).
//
// We substitute the project-id fetcher via _setProjectFetcherForTests
// so the tests are hermetic and don't depend on gcp-metadata's internal
// caching or actual network reachability.

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  createGcpSink,
  _resetMetadataProjectCacheForTests,
  _setProjectFetcherForTests,
} from "../src/gcp"

let captured: string[]
let originalLog: typeof console.log
let originalEnv: { project?: string; gcloud?: string }

beforeEach(() => {
  captured = []
  originalLog = console.log
  console.log = (s: string) => captured.push(s)
  originalEnv = {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    gcloud: process.env.GCLOUD_PROJECT,
  }
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.GCLOUD_PROJECT
  _resetMetadataProjectCacheForTests()
})

afterEach(() => {
  console.log = originalLog
  _setProjectFetcherForTests(undefined)
  if (originalEnv.project !== undefined) {
    process.env.GOOGLE_CLOUD_PROJECT = originalEnv.project
  }
  if (originalEnv.gcloud !== undefined) {
    process.env.GCLOUD_PROJECT = originalEnv.gcloud
  }
})

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("GCP project auto-detection", () => {
  it("uses metadata fetcher when no explicit project and no env vars", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      return "my-detected-project"
    })

    const sink = createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/my-detected-project/traces/abc123")
    expect(calls).toBe(1)
  })

  it("explicit project skips metadata detection entirely", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      return "should-not-be-used"
    })

    const sink = createGcpSink({ name: "t", project: "explicit-proj" })
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/explicit-proj/traces/abc123")
    expect(calls).toBe(0)
  })

  it("GOOGLE_CLOUD_PROJECT env skips metadata detection", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      return "should-not-be-used"
    })

    process.env.GOOGLE_CLOUD_PROJECT = "env-proj"
    const sink = createGcpSink({ name: "t" })
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBe("projects/env-proj/traces/abc123")
    expect(calls).toBe(0)
  })

  it("projectAutoDetect:false disables metadata fetch", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      return "nope"
    })

    const sink = createGcpSink({ name: "t", projectAutoDetect: false })
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBeUndefined()
    expect(calls).toBe(0)
  })

  it("fetcher returning undefined leaves project unresolved", async () => {
    _setProjectFetcherForTests(async () => undefined)

    const sink = createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    sink.write("info", "hello", { trace_id: "abc123" })
    const entry = JSON.parse(captured[0]!)
    expect(entry["logging.googleapis.com/trace"]).toBeUndefined()
  })

  it("fetcher error (non-GCP env) cached: only one attempt across multiple log calls", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      throw new Error("ENOTFOUND metadata.google.internal")
    })

    const sink = createGcpSink({ name: "t" })
    await flushPromises()
    await flushPromises()

    sink.write("info", "first", { trace_id: "abc" })
    sink.write("info", "second", { trace_id: "def" })
    sink.write("info", "third", { trace_id: "ghi" })

    expect(calls).toBe(1)
    for (const line of captured) {
      const e = JSON.parse(line)
      expect(e["logging.googleapis.com/trace"]).toBeUndefined()
    }
  })

  it("fetcher success cached across multiple sinks", async () => {
    let calls = 0
    _setProjectFetcherForTests(async () => {
      calls++
      return "cached-project"
    })

    createGcpSink({ name: "a" })
    createGcpSink({ name: "b" })
    createGcpSink({ name: "c" })
    await flushPromises()
    await flushPromises()

    // Detection runs once per process despite three sinks.
    expect(calls).toBe(1)
  })
})
